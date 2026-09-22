const { db, logError } = require('../cache/db');
const timers = require('../timer/manager');
const routing = require('../routing/status');
const clickup = require('../api/clickup');
const offlineQueue = require('../queue/offline');
const { CU_REF_REGEX } = require('../api/drive');

const STAFF_SCAN_TIMEOUT_MS = 10000;

// Single kiosk terminal -> a single global scan session is exactly what the
// spec's state machine assumes ("scan item, scan badge, work, scan item,
// scan badge"). If this ever runs multiple physical scanners, each would
// need its own keyed session; not needed for the pilot (Section 14.5/14.6
// cover the multi-board future instead).
const session = {
  status: 'IDLE', // IDLE | AWAITING_STAFF
  item: null,
  timeoutHandle: null,
  expiresAt: null,
};

// timerId -> { nextStatus, ambiguousChoices, timer, item, createdAt }
const pendingCompletions = new Map();

function resetToIdle() {
  if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
  session.status = 'IDLE';
  session.item = null;
  session.timeoutHandle = null;
  session.expiresAt = null;
}

function isItemCode(code) {
  return CU_REF_REGEX.test(code.trim());
}

function findTaskByCuRef(cuRef) {
  return db.prepare('SELECT * FROM tasks_cache WHERE cu_reference = ?').get(cuRef);
}

function findStaff(staffId) {
  const row = db.prepare('SELECT * FROM staff WHERE staff_id = ?').get(staffId);
  if (row) return row;
  // Unregistered badge: accept it so the floor never blocks on admin setup,
  // but flag it so the admin page surfaces it for registration.
  logError('scanner', `Unregistered staff badge scanned: "${staffId}" - accepted as ad-hoc staff`, 'warning');
  return { staff_id: staffId, name: staffId, clickup_user_id: null };
}

function proposeNextStatus(taskRow) {
  const itemType = routing.detectItemType(taskRow.item_name, taskRow.description);
  const result = routing.getNextStatus(taskRow.status, itemType);
  if (result.nextStatus) return { itemType, nextStatus: result.nextStatus };

  const choices = routing.getAmbiguousChoices(taskRow.status);
  if (choices.length > 1) return { itemType, ambiguousChoices: choices };

  return { itemType, nextStatus: null, reason: result.reason };
}

/**
 * Handle one scanned code arriving from the frontend's HID keystroke buffer.
 * Returns a plain object the frontend renders directly; see the `type`
 * field for the UI state to show.
 */
async function handleScan(rawCode) {
  const code = (rawCode || '').trim();
  if (!code) return { type: 'error', message: 'Empty scan' };

  if (session.status === 'IDLE') {
    if (!isItemCode(code)) {
      return { type: 'error', message: 'Scan an item QR code first' };
    }
    const task = findTaskByCuRef(code);
    if (!task) {
      return { type: 'error', message: `No active item found for ${code}` };
    }
    session.status = 'AWAITING_STAFF';
    session.item = task;
    session.expiresAt = Date.now() + STAFF_SCAN_TIMEOUT_MS;
    session.timeoutHandle = setTimeout(() => {
      resetToIdle();
    }, STAFF_SCAN_TIMEOUT_MS);
    return { type: 'awaiting_staff', item: task, expiresAt: session.expiresAt };
  }

  // AWAITING_STAFF
  if (isItemCode(code)) {
    // Carpenter re-scanned a (possibly different) item before badging in -
    // treat it as switching the pending item and restart the 10s window.
    const task = findTaskByCuRef(code);
    if (!task) return { type: 'error', message: `No active item found for ${code}` };
    if (session.timeoutHandle) clearTimeout(session.timeoutHandle);
    session.item = task;
    session.expiresAt = Date.now() + STAFF_SCAN_TIMEOUT_MS;
    session.timeoutHandle = setTimeout(resetToIdle, STAFF_SCAN_TIMEOUT_MS);
    return { type: 'awaiting_staff', item: task, expiresAt: session.expiresAt };
  }

  const item = session.item;
  resetToIdle();

  const staff = findStaff(code);
  const existing = timers.getActiveTimerForItem(item.task_id);

  if (!existing) {
    return startAction(item, staff);
  }
  if (existing.staff_id === staff.staff_id) {
    if (existing.status === 'running') {
      return doneAction(existing, item);
    }
    return resumeAction(existing, item, staff);
  }
  return { type: 'conflict', item, timer: existing, staff, currentStaffName: existing.staff_name || existing.staff_id };
}

async function startAction(item, staff) {
  // Multi-task handling: pause any other item this staff member is
  // currently timed into.
  const otherRunning = timers.getActiveTimerForStaff(staff.staff_id);
  if (otherRunning && otherRunning.item_id !== item.task_id) {
    timers.pauseTimer(otherRunning.id);
  }

  const timer = await timers.startTimer({
    itemId: item.task_id,
    cuReference: item.cu_reference,
    staffId: staff.staff_id,
    staffName: staff.name,
    assigneeUserId: staff.clickup_user_id,
  });

  return { type: 'started', item, timer, pausedOther: otherRunning ? otherRunning.item_id : null };
}

function resumeAction(timerRow, item, staff) {
  const otherRunning = timers.getActiveTimerForStaff(staff.staff_id);
  if (otherRunning && otherRunning.id !== timerRow.id) {
    timers.pauseTimer(otherRunning.id);
  }
  const timer = timers.resumeTimer(timerRow.id);
  return { type: 'resumed', item, timer, pausedOther: otherRunning ? otherRunning.item_id : null };
}

function doneAction(timerRow, item) {
  // Pause (not stop) while the carpenter confirms - Cancel must be able to
  // resume the clock exactly where it left off.
  timers.pauseTimer(timerRow.id);
  const proposal = proposeNextStatus(item);

  pendingCompletions.set(timerRow.id, {
    timer: timerRow,
    item,
    itemType: proposal.itemType,
    nextStatus: proposal.nextStatus || null,
    ambiguousChoices: proposal.ambiguousChoices || null,
    reason: proposal.reason || null,
    createdAt: Date.now(),
  });

  return {
    type: 'confirm_completion',
    timerId: timerRow.id,
    item,
    nextStatus: proposal.nextStatus || null,
    ambiguousChoices: proposal.ambiguousChoices || null,
    reason: proposal.reason || null,
    countdownSeconds: 5,
  };
}

/** Cancel a pending completion - resume the timer, discard the proposal. */
function cancelCompletion(timerId) {
  const pending = pendingCompletions.get(timerId);
  if (!pending) return { ok: false, message: 'No pending completion for that timer' };
  pendingCompletions.delete(timerId);
  const timer = timers.resumeTimer(timerId);
  return { ok: true, timer };
}

/**
 * Confirm a pending completion once the 5s countdown elapses client-side.
 * `chosenStatus` is required when the proposal was ambiguous.
 */
async function confirmCompletion(timerId, chosenStatus) {
  const pending = pendingCompletions.get(timerId);
  if (!pending) return { ok: false, message: 'No pending completion for that timer' };

  let nextStatus = pending.nextStatus;
  if (!nextStatus) {
    if (pending.ambiguousChoices && chosenStatus && pending.ambiguousChoices.includes(chosenStatus)) {
      nextStatus = chosenStatus;
    } else if (!pending.ambiguousChoices) {
      pendingCompletions.delete(timerId);
      return { ok: false, message: pending.reason || 'No valid next status for this item' };
    } else {
      return { ok: false, message: 'A status choice is required', choices: pending.ambiguousChoices };
    }
  }

  pendingCompletions.delete(timerId);

  const { timer, productionMs } = await timers.stopTimer(timerId);

  await offlineQueue.tryOrQueue(
    'status_change',
    { taskId: pending.item.task_id, status: nextStatus },
    () => clickup.updateTaskStatus(pending.item.task_id, nextStatus)
  );

  db.prepare('UPDATE tasks_cache SET status = ? WHERE task_id = ?').run(nextStatus, pending.item.task_id);

  return { ok: true, timer, productionMs, nextStatus };
}

/** "Take over" an item someone else is currently timed into. */
async function takeover(itemId, newStaffCode) {
  const existing = timers.getActiveTimerForItem(itemId);
  const item = db.prepare('SELECT * FROM tasks_cache WHERE task_id = ?').get(itemId);
  if (!item) return { ok: false, message: 'Unknown item' };

  if (existing) {
    await timers.stopTimer(existing.id);
  }
  const staff = findStaff(newStaffCode);
  const result = await startAction(item, staff);
  return { ok: true, ...result };
}

function getSessionState() {
  return {
    status: session.status,
    item: session.item,
    expiresAt: session.expiresAt,
  };
}

function getPendingCompletion(timerId) {
  return pendingCompletions.get(timerId) || null;
}

module.exports = {
  handleScan,
  cancelCompletion,
  confirmCompletion,
  takeover,
  getSessionState,
  getPendingCompletion,
  resetToIdle,
};
