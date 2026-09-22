const { db, logError, setSyncSuccess, setSyncError } = require('../cache/db');
const clickup = require('../api/clickup');

let clickupReachable = true;

function isClickupReachable() {
  return clickupReachable;
}

/** Queue a write for later replay (called when a direct ClickUp call fails). */
function enqueue(operationType, payload) {
  db.prepare('INSERT INTO offline_queue (operation_type, payload_json) VALUES (?, ?)')
    .run(operationType, JSON.stringify(payload));
}

function listPending() {
  return db.prepare("SELECT * FROM offline_queue WHERE status = 'pending' ORDER BY id ASC").all();
}

function listAll(limit = 100) {
  return db.prepare('SELECT * FROM offline_queue ORDER BY id DESC LIMIT ?').all(limit);
}

// time_entry_start/stop resolve against active_timers.id (not a ClickUp
// entry id, which may not exist yet) directly via `db` here rather than
// requiring src/timer/manager, which itself requires this module - see the
// comments on startTimer/stopTimer there for why the id has to round-trip
// through the local row instead of being captured at queue time.
async function applyOperation(op) {
  const payload = JSON.parse(op.payload_json);
  switch (op.operation_type) {
    case 'status_change':
      return clickup.updateTaskStatus(payload.taskId, payload.status);
    case 'time_entry_start': {
      const result = await clickup.startTimeEntry(payload.taskId, payload.assigneeUserId);
      const entryId = result && result.data ? result.data.id : (result ? result.id : null);
      if (entryId) {
        db.prepare('UPDATE active_timers SET clickup_time_entry_id = ? WHERE id = ?').run(entryId, payload.localTimerId);
      }
      return result;
    }
    case 'time_entry_stop': {
      const row = db.prepare('SELECT * FROM active_timers WHERE id = ?').get(payload.localTimerId);
      if (!row || !row.clickup_time_entry_id) {
        throw new Error(`Timer ${payload.localTimerId} has no ClickUp time entry id yet - its start hasn't synced`);
      }
      return clickup.stopTimeEntry(row.clickup_time_entry_id);
    }
    case 'comment':
      return clickup.postComment(payload.taskId, payload.commentText, payload.notifyUserIds);
    default:
      throw new Error(`Unknown queued operation_type: ${op.operation_type}`);
  }
}

/**
 * Try an operation immediately; if it fails (network / ClickUp down), queue
 * it for later replay instead of losing it. Returns { ok, queued, result }.
 */
async function tryOrQueue(operationType, payload, directCallFn) {
  try {
    const result = await directCallFn();
    clickupReachable = true;
    setSyncSuccess('clickup');
    return { ok: true, queued: false, result };
  } catch (err) {
    clickupReachable = false;
    setSyncError('clickup', err.message);
    enqueue(operationType, payload);
    return { ok: false, queued: true, error: err.message };
  }
}

/** Replay all pending queued writes in order. Stops at the first failure to preserve ordering. */
async function replayQueue() {
  const pending = listPending();
  let synced = 0;
  let failed = 0;
  for (const op of pending) {
    try {
      await applyOperation(op);
      db.prepare("UPDATE offline_queue SET status = 'synced', synced_at = datetime('now'), attempts = attempts + 1 WHERE id = ?").run(op.id);
      synced += 1;
      clickupReachable = true;
      setSyncSuccess('clickup');
    } catch (err) {
      db.prepare('UPDATE offline_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(err.message, op.id);
      logError('offline_queue', `Failed to replay op ${op.id} (${op.operation_type}): ${err.message}`, 'warning');
      failed += 1;
      clickupReachable = false;
      setSyncError('clickup', err.message);
      break; // preserve order: don't skip ahead past a still-failing write
    }
  }
  return { synced, failed, remaining: listPending().length };
}

module.exports = { enqueue, listPending, listAll, tryOrQueue, replayQueue, isClickupReachable };
