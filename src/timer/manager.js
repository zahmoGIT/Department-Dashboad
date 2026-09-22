const { db, logError } = require('../cache/db');
const config = require('../config');
const clickup = require('../api/clickup');
const offlineQueue = require('../queue/offline');

// ---------------------------------------------------------------------------
// Work-schedule deduction (Section 6 "Work schedule config").
// Timers are server-side and can span outages, overnight, or weekends, so
// "production time" subtracts any non-working periods that fall inside the
// timer's start-to-end window before it's reported/displayed.
// ---------------------------------------------------------------------------

function parseHHMM(str, onDate) {
  const [h, m] = str.split(':').map(Number);
  const d = new Date(onDate);
  d.setHours(h, m, 0, 0);
  return d;
}

function isPublicHoliday(date) {
  const iso = date.toISOString().slice(0, 10);
  return config.schedule.public_holidays.includes(iso);
}

/** Working window(s) for a given calendar day, as [{start,end}, ...] Date pairs (shift minus lunch). */
function workingWindowsForDay(date) {
  if (isPublicHoliday(date)) return [];

  const dow = date.getDay(); // 0 = Sunday ... 6 = Saturday
  let shiftStart; let shiftEnd; let lunchStart; let lunchEnd;

  if (dow === 6) {
    const sat = config.schedule.saturday;
    if (!sat) return [];
    shiftStart = sat.shift_start;
    shiftEnd = sat.shift_end;
    lunchStart = sat.lunch_start;
    lunchEnd = sat.lunch_end;
  } else if (config.schedule.working_days.includes(dow)) {
    shiftStart = config.schedule.shift_start;
    shiftEnd = config.schedule.shift_end;
    lunchStart = config.schedule.lunch_start;
    lunchEnd = config.schedule.lunch_end;
  } else {
    return [];
  }

  const start = parseHHMM(shiftStart, date);
  const end = parseHHMM(shiftEnd, date);

  if (!lunchStart || !lunchEnd) return [{ start, end }];

  const lStart = parseHHMM(lunchStart, date);
  const lEnd = parseHHMM(lunchEnd, date);
  return [{ start, end: lStart }, { start: lEnd, end }];
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, end - start);
}

/** Sum of working-schedule time (ms) that overlaps [from, to]. */
function workingMsInRange(from, to) {
  if (to <= from) return 0;
  let total = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  while (cursor < to) {
    for (const window of workingWindowsForDay(cursor)) {
      total += overlapMs(from, to, window.start, window.end);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Timer CRUD / state machine
// ---------------------------------------------------------------------------

function getActiveTimerForItem(itemId) {
  return db.prepare(`
    SELECT * FROM active_timers WHERE item_id = ? AND status != 'stopped' ORDER BY id DESC LIMIT 1
  `).get(itemId);
}

function getActiveTimerForStaff(staffId) {
  return db.prepare(`
    SELECT * FROM active_timers WHERE staff_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1
  `).get(staffId);
}

function getAllActiveTimers() {
  return db.prepare(`SELECT * FROM active_timers WHERE status != 'stopped' ORDER BY started_at ASC`).all();
}

function getTimer(id) {
  return db.prepare('SELECT * FROM active_timers WHERE id = ?').get(id);
}

async function startTimer({ itemId, cuReference, staffId, staffName, assigneeUserId }) {
  const startedAt = new Date().toISOString();

  const info = db.prepare(`
    INSERT INTO active_timers (item_id, cu_reference, staff_id, staff_name, started_at, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(itemId, cuReference || null, staffId, staffName || null, startedAt);
  const localTimerId = info.lastInsertRowid;

  // Queued by localTimerId (not a ClickUp entry id, which doesn't exist
  // yet) so a later replay can both create the entry *and* write its id
  // back onto this row - see applyStartOperation below. Without that link,
  // a start that gets queued offline would leave clickup_time_entry_id
  // permanently null, and the matching stop would have nothing to stop.
  await offlineQueue.tryOrQueue(
    'time_entry_start',
    { localTimerId, taskId: itemId, assigneeUserId },
    async () => {
      const result = await clickup.startTimeEntry(itemId, assigneeUserId);
      applyStartResult(localTimerId, result);
      return result;
    }
  );

  return getTimer(localTimerId);
}

function applyStartResult(localTimerId, result) {
  const entryId = result && result.data ? result.data.id : (result ? result.id : null);
  if (entryId) {
    db.prepare('UPDATE active_timers SET clickup_time_entry_id = ? WHERE id = ?').run(entryId, localTimerId);
  }
}

async function stopTimer(timerId) {
  const timer = getTimer(timerId);
  if (!timer) throw new Error(`No active timer with id ${timerId}`);

  const endedAt = new Date().toISOString();

  // Queued by localTimerId too, and resolves the ClickUp entry id at
  // execution time rather than call time - if the matching start is still
  // sitting in the queue, tryOrQueue's own ordering guarantee (it stops
  // replay at the first failure) means the start always runs before this
  // stop, so the id is available by the time this executes.
  await offlineQueue.tryOrQueue(
    'time_entry_stop',
    { localTimerId: timerId },
    () => stopTimerEntryForLocalId(timerId)
  );

  db.prepare(`UPDATE active_timers SET status = 'stopped', ended_at = ? WHERE id = ?`).run(endedAt, timerId);

  const finalTimer = getTimer(timerId);
  return { timer: finalTimer, productionMs: productionMsForTimer(finalTimer) };
}

function stopTimerEntryForLocalId(localTimerId) {
  const row = getTimer(localTimerId);
  if (!row || !row.clickup_time_entry_id) {
    throw new Error(`Timer ${localTimerId} has no ClickUp time entry id yet - its start hasn't synced`);
  }
  return clickup.stopTimeEntry(row.clickup_time_entry_id);
}

/** Pause a running timer (multi-task handling - Section 5). */
function pauseTimer(timerId) {
  const timer = getTimer(timerId);
  if (!timer || timer.status !== 'running') return timer;
  db.prepare(`UPDATE active_timers SET status = 'paused', paused_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), timerId);
  return getTimer(timerId);
}

/** Resume a paused timer, folding the paused duration into total_paused_ms. */
function resumeTimer(timerId) {
  const timer = getTimer(timerId);
  if (!timer || timer.status !== 'paused') return timer;
  const pausedMs = Date.now() - new Date(timer.paused_at).getTime();
  db.prepare(`
    UPDATE active_timers SET status = 'running', paused_at = NULL, total_paused_ms = total_paused_ms + ? WHERE id = ?
  `).run(pausedMs, timerId);
  return getTimer(timerId);
}

/**
 * Elapsed wall-clock ms for a timer, excluding any currently-paused or
 * previously-paused stretches. Used for the live HH:MM:SS display.
 */
function elapsedMs(timer, now = Date.now()) {
  const start = new Date(timer.started_at).getTime();
  const end = timer.ended_at ? new Date(timer.ended_at).getTime() : now;
  let paused = timer.total_paused_ms || 0;
  if (timer.status === 'paused' && timer.paused_at) {
    paused += now - new Date(timer.paused_at).getTime();
  }
  return Math.max(0, (end - start) - paused);
}

/** Production ms = elapsed ms further reduced by non-working schedule time. */
function productionMsForTimer(timer, now = Date.now()) {
  const start = new Date(timer.started_at);
  const end = timer.ended_at ? new Date(timer.ended_at) : new Date(now);
  const rawSpanMs = Math.max(0, end.getTime() - start.getTime());
  const nonPausedFraction = rawSpanMs === 0 ? 0 : elapsedMs(timer, now) / rawSpanMs;
  const workingMs = workingMsInRange(start, end);
  // Apply the same paused-time ratio to the schedule-bounded working time,
  // so a lunchtime pause and a multi-task pause don't get double-subtracted.
  return Math.round(workingMs * nonPausedFraction);
}

/**
 * On server startup: any timer left with status running/paused simply stays
 * that way (per Section 6, "no data loss" on power recovery) - nothing to
 * repair here beyond logging what's still active for visibility.
 */
function resumeFromCrash() {
  const active = getAllActiveTimers();
  if (active.length > 0) {
    logError('timer_manager', `Resumed ${active.length} active timer(s) from disk after restart`, 'warning');
  }
  return active;
}

module.exports = {
  startTimer,
  stopTimer,
  pauseTimer,
  resumeTimer,
  getActiveTimerForItem,
  getActiveTimerForStaff,
  getAllActiveTimers,
  getTimer,
  elapsedMs,
  productionMsForTimer,
  workingMsInRange,
  resumeFromCrash,
};
