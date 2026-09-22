const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const express = require('express');
const basicAuth = require('express-basic-auth');

const config = require('./src/config');
const { db, logError } = require('./src/cache/db');
const cache = require('./src/cache/index');
const timers = require('./src/timer/manager');
const scanner = require('./src/scanner/input');
const offlineQueue = require('./src/queue/offline');
const clickup = require('./src/api/clickup');
const driveApi = require('./src/api/drive');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// Startup: resume any timers left running across a restart/power cut.
// ---------------------------------------------------------------------------
timers.resumeFromCrash();
cache.startBackgroundJobs();

// ---------------------------------------------------------------------------
// Public dashboard API
// ---------------------------------------------------------------------------

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function priorityRank(priority) {
  if (!priority) return 99;
  return PRIORITY_RANK[String(priority).toLowerCase()] ?? 99;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pr = priorityRank(a.priority) - priorityRank(b.priority);
    if (pr !== 0) return pr;
    const aDue = a.due_date ? Number(a.due_date) : Infinity;
    const bDue = b.due_date ? Number(b.due_date) : Infinity;
    return aDue - bDue;
  });
}

function decorateTask(row) {
  const activeTimer = timers.getActiveTimerForItem(row.task_id);
  return {
    ...row,
    assignees: JSON.parse(row.assignee_json || '[]'),
    activeTimer: activeTimer ? {
      id: activeTimer.id,
      staffId: activeTimer.staff_id,
      staffName: activeTimer.staff_name,
      status: activeTimer.status,
      startedAt: activeTimer.started_at,
      elapsedMs: timers.elapsedMs(activeTimer),
    } : null,
  };
}

app.get('/api/tasks', (req, res) => {
  const all = cache.getCachedTasks().map(decorateTask);
  const columns = config.dashboardConfig.columns.map((col) => ({
    key: col.key,
    label: col.label,
    items: sortTasks(all.filter((t) => col.statuses.includes(t.status))),
  }));
  res.json({ columns });
});

app.get('/api/tasks/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tasks_cache WHERE task_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(decorateTask(row));
});

app.get('/api/documents/:cuRef', (req, res) => {
  const files = cache.getDocumentsForCuRef(req.params.cuRef);
  const byType = { job_sheet: null, cutlist: null, drawing: null };
  for (const f of files) {
    if (!byType[f.file_type]) byType[f.file_type] = f;
  }
  res.json(byType);
});

app.get('/api/documents/file/:fileId', async (req, res) => {
  const row = db.prepare('SELECT * FROM drive_index WHERE file_id = ?').get(req.params.fileId);
  if (!row) return res.status(404).json({ error: 'File not indexed' });

  const cachePath = path.join(config.fileCacheDir, row.file_id);
  if (fs.existsSync(cachePath)) {
    res.setHeader('Content-Type', row.mime_type === 'application/vnd.google-apps.spreadsheet' ? 'application/pdf' : row.mime_type);
    return fs.createReadStream(cachePath).pipe(res);
  }

  try {
    const { stream, mimeType } = await driveApi.downloadFile(row.file_id, row.mime_type);
    res.setHeader('Content-Type', mimeType);

    const toClient = new PassThrough();
    const toCache = new PassThrough();
    stream.pipe(toClient);
    stream.pipe(toCache);
    toClient.pipe(res);
    toCache.pipe(fs.createWriteStream(cachePath)).on('error', (err) => logError('file_cache', err.message, 'warning'));
  } catch (err) {
    logError('drive_download', `Failed to fetch file ${row.file_id}: ${err.message}`);
    res.status(502).json({ error: 'Could not fetch file from Google Drive' });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const result = await scanner.handleScan(req.body.code);
    res.json(result);
  } catch (err) {
    logError('scan', err.message);
    res.status(500).json({ type: 'error', message: err.message });
  }
});

app.post('/api/scan/takeover', async (req, res) => {
  try {
    const { itemId, staffCode } = req.body;
    const result = await scanner.takeover(itemId, staffCode);
    res.json(result);
  } catch (err) {
    logError('scan_takeover', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/scan/session', (req, res) => {
  res.json(scanner.getSessionState());
});

app.post('/api/completion/:timerId/cancel', (req, res) => {
  const result = scanner.cancelCompletion(Number(req.params.timerId));
  res.json(result);
});

app.post('/api/completion/:timerId/confirm', async (req, res) => {
  try {
    const result = await scanner.confirmCompletion(Number(req.params.timerId), req.body.chosenStatus);
    res.json(result);
  } catch (err) {
    logError('completion_confirm', err.message);
    res.status(500).json({ ok: false, message: err.message });
  }
});

const PROBLEM_TYPES = ['Missing parts', 'Wrong dimensions', 'Material defect', 'Other'];

app.post('/api/tasks/:id/report-problem', async (req, res) => {
  const { category, note } = req.body;
  if (!PROBLEM_TYPES.includes(category)) {
    return res.status(400).json({ ok: false, message: `category must be one of ${PROBLEM_TYPES.join(', ')}` });
  }
  const taskId = req.params.id;
  const activeTimer = timers.getActiveTimerForItem(taskId);
  const reportedBy = activeTimer ? (activeTimer.staff_name || activeTimer.staff_id) : 'Unknown';

  const commentText = [
    '⚠️ PROBLEM REPORTED',
    `Type: ${category}`,
    `Note: ${category === 'Other' ? (note || '').slice(0, 500) : '-'}`,
    `Reported by: ${reportedBy}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  const outcome = await offlineQueue.tryOrQueue(
    'comment',
    { taskId, commentText, notifyUserIds: config.clickup.notifyUserIds },
    () => clickup.postComment(taskId, commentText, config.clickup.notifyUserIds)
  );

  res.json({ ok: outcome.ok, queued: outcome.queued });
});

app.get('/api/status', (req, res) => {
  const clickupSync = db.prepare("SELECT * FROM sync_status WHERE key = 'clickup_poll'").get();
  const driveSync = db.prepare("SELECT * FROM sync_status WHERE key = 'drive'").get();
  const pendingCount = db.prepare("SELECT COUNT(*) c FROM offline_queue WHERE status = 'pending'").get().c;
  const activeTimerCount = timers.getAllActiveTimers().length;

  res.json({
    clickup: {
      online: offlineQueue.isClickupReachable(),
      lastSuccessAt: clickupSync ? clickupSync.last_success_at : null,
      lastError: clickupSync ? clickupSync.last_error : null,
    },
    drive: {
      lastSuccessAt: driveSync ? driveSync.last_success_at : null,
      lastError: driveSync ? driveSync.last_error : null,
    },
    offlineQueuePending: pendingCount,
    activeTimerCount,
  });
});

// ---------------------------------------------------------------------------
// Admin API (HTTP Basic Auth)
// ---------------------------------------------------------------------------

const adminAuth = basicAuth({
  users: { [config.admin.username]: config.admin.password },
  challenge: true,
  realm: 'DepDash Admin',
});

// admin.html lives under public/admin/ (its own subdirectory, not public/'s
// top level) so every URL that could reach it - /admin, /admin/,
// /admin/index.html - starts with the "/admin" prefix and is always gated
// by adminAuth first. A same-named file at the public/ top level would be
// reachable unauthenticated via a path like /admin.html that doesn't match
// the "/admin" mount boundary.
app.use('/admin', adminAuth, express.static(path.join(__dirname, 'public', 'admin'), { index: 'index.html' }));
app.use('/api/admin', adminAuth);

app.get('/api/admin/overview', (req, res) => {
  const clickupSync = db.prepare("SELECT * FROM sync_status WHERE key = 'clickup_poll'").get();
  const driveSync = db.prepare("SELECT * FROM sync_status WHERE key = 'drive'").get();
  res.json({
    clickup: clickupSync || null,
    drive: driveSync || null,
    clickupOnline: offlineQueue.isClickupReachable(),
  });
});

app.get('/api/admin/timers', (req, res) => {
  const active = timers.getAllActiveTimers().map((t) => ({
    ...t,
    elapsedMs: timers.elapsedMs(t),
    productionMs: timers.productionMsForTimer(t),
  }));
  res.json(active);
});

app.post('/api/admin/timers/:id/correct', (req, res) => {
  const { started_at, ended_at } = req.body;
  const fields = [];
  const values = [];
  if (started_at) { fields.push('started_at = ?'); values.push(started_at); }
  if (ended_at !== undefined) { fields.push('ended_at = ?'); values.push(ended_at); }
  if (fields.length === 0) return res.status(400).json({ ok: false, message: 'Nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE active_timers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true, timer: timers.getTimer(req.params.id) });
});

app.post('/api/admin/timers/:id/stop', async (req, res) => {
  try {
    const result = await timers.stopTimer(Number(req.params.id));
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/admin/queue', (req, res) => {
  res.json(offlineQueue.listAll(200));
});

app.post('/api/admin/queue/retry', async (req, res) => {
  const result = await offlineQueue.replayQueue();
  res.json(result);
});

app.get('/api/admin/drive-index', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM drive_index').get().c;
  const errors = db.prepare('SELECT * FROM drive_index_errors ORDER BY detected_at DESC').all();
  const driveSync = db.prepare("SELECT * FROM sync_status WHERE key = 'drive'").get();
  res.json({ totalIndexed: total, lastScanAt: driveSync ? driveSync.last_success_at : null, errors });
});

app.get('/api/admin/errors', (req, res) => {
  res.json(db.prepare('SELECT * FROM error_log ORDER BY id DESC LIMIT 100').all());
});

app.post('/api/admin/force-sync', async (req, res) => {
  const [clickupResult, driveResult] = await Promise.all([cache.refreshClickUpCache(), cache.refreshDriveIndex()]);
  res.json({ clickup: clickupResult, drive: driveResult });
});

app.post('/api/admin/tasks/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ ok: false, message: 'status is required' });
  const outcome = await offlineQueue.tryOrQueue(
    'status_change',
    { taskId: req.params.id, status },
    () => clickup.updateTaskStatus(req.params.id, status)
  );
  db.prepare('UPDATE tasks_cache SET status = ? WHERE task_id = ?').run(status, req.params.id);
  res.json({ ok: outcome.ok, queued: outcome.queued });
});

app.get('/api/admin/routing-config', (req, res) => {
  res.json({ routing: config.routing, schedule: config.schedule, dashboard: config.dashboardConfig, paths: config.configPaths });
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.use((err, req, res, next) => {
  logError('server', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`DepDash backend listening on http://localhost:${config.port}`);
});

process.on('SIGTERM', () => { cache.stopBackgroundJobs(); process.exit(0); });
process.on('SIGINT', () => { cache.stopBackgroundJobs(); process.exit(0); });
