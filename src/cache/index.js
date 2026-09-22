const { db, setSyncSuccess, setSyncError } = require('./db');
const config = require('../config');
const clickup = require('../api/clickup');
const drive = require('../api/drive');
const { CU_REF_REGEX } = require('../api/drive');

// ---------------------------------------------------------------------------
// ClickUp task cache
// ---------------------------------------------------------------------------

function extractCuReference(task) {
  const field = (task.custom_fields || []).find((f) =>
    (f.name || '').toLowerCase().includes('cu') && (f.name || '').toLowerCase().includes('reference'));
  if (field && field.value) return String(field.value);

  if (task.custom_id) return task.custom_id;

  const match = (task.name || '').match(CU_REF_REGEX);
  return match ? match[0] : null;
}

function normalizeTask({ task, parent }) {
  return {
    task_id: task.id,
    parent_task_id: task.parent || null,
    cu_reference: extractCuReference(task),
    client_name: parent ? parent.name : null,
    quote_ref: parent ? extractCuReference(parent) : null,
    item_name: task.name,
    status: task.status ? task.status.status : null,
    priority: task.priority ? task.priority.priority : null,
    due_date: task.due_date || null,
    assignee_json: JSON.stringify(task.assignees || []),
    description: task.text_content || task.description || '',
    attachment_count: (task.attachments || []).length,
    comment_count: task.comment_count || 0,
    raw_json: JSON.stringify(task),
  };
}

function upsertTasksCache(normalizedTasks) {
  const upsert = db.prepare(`
    INSERT INTO tasks_cache (
      task_id, parent_task_id, cu_reference, client_name, quote_ref, item_name,
      status, priority, due_date, assignee_json, description, attachment_count,
      comment_count, raw_json, updated_at
    ) VALUES (
      @task_id, @parent_task_id, @cu_reference, @client_name, @quote_ref, @item_name,
      @status, @priority, @due_date, @assignee_json, @description, @attachment_count,
      @comment_count, @raw_json, datetime('now')
    )
    ON CONFLICT(task_id) DO UPDATE SET
      parent_task_id = excluded.parent_task_id,
      cu_reference = excluded.cu_reference,
      client_name = excluded.client_name,
      quote_ref = excluded.quote_ref,
      item_name = excluded.item_name,
      status = excluded.status,
      priority = excluded.priority,
      due_date = excluded.due_date,
      assignee_json = excluded.assignee_json,
      description = excluded.description,
      attachment_count = excluded.attachment_count,
      comment_count = excluded.comment_count,
      raw_json = excluded.raw_json,
      updated_at = datetime('now')
  `);

  const currentIds = normalizedTasks.map((t) => t.task_id);

  const tx = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
    // Remove cached tasks that are no longer in wood work / assembly wood
    // work (they've moved on, or dropped off the WIP list) so stale cards
    // don't linger on the dashboard.
    if (currentIds.length > 0) {
      const placeholders = currentIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM tasks_cache WHERE task_id NOT IN (${placeholders})`).run(...currentIds);
    } else {
      db.prepare('DELETE FROM tasks_cache').run();
    }
  });
  tx(normalizedTasks);
}

async function refreshClickUpCache() {
  try {
    const statuses = config.dashboardConfig.columns.flatMap((c) => c.statuses);
    const raw = await clickup.fetchWipTasks(statuses);
    const normalized = raw.map(normalizeTask);
    upsertTasksCache(normalized);
    setSyncSuccess('clickup_poll');
    return { ok: true, count: normalized.length };
  } catch (err) {
    setSyncError('clickup_poll', err.message);
    return { ok: false, error: err.message };
  }
}

function getCachedTasks() {
  return db.prepare('SELECT * FROM tasks_cache ORDER BY updated_at DESC').all();
}

// ---------------------------------------------------------------------------
// Drive index
// ---------------------------------------------------------------------------

function upsertDriveIndex(indexed, errors) {
  const upsertFile = db.prepare(`
    INSERT INTO drive_index (cu_reference, file_id, file_name, file_type, folder_source, mime_type, last_modified, download_url)
    VALUES (@cu_reference, @file_id, @file_name, @file_type, @folder_source, @mime_type, @last_modified, @download_url)
    ON CONFLICT(file_id) DO UPDATE SET
      cu_reference = excluded.cu_reference,
      file_name = excluded.file_name,
      file_type = excluded.file_type,
      folder_source = excluded.folder_source,
      mime_type = excluded.mime_type,
      last_modified = excluded.last_modified,
      download_url = excluded.download_url
  `);
  const insertError = db.prepare(`
    INSERT INTO drive_index_errors (file_name, file_id, folder_source, reason) VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const currentFileIds = indexed.map((f) => f.file_id);
    for (const f of indexed) upsertFile.run(f);
    if (currentFileIds.length > 0) {
      const placeholders = currentFileIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM drive_index WHERE file_id NOT IN (${placeholders})`).run(...currentFileIds);
    } else {
      db.prepare('DELETE FROM drive_index').run();
    }

    db.prepare('DELETE FROM drive_index_errors').run();
    for (const e of errors) insertError.run(e.file_name, e.file_id || null, e.folder_source || null, e.reason);
  });
  tx();
}

async function refreshDriveIndex() {
  try {
    const { indexed, errors } = await drive.buildDriveIndex();
    upsertDriveIndex(indexed, errors);
    setSyncSuccess('drive');
    return { ok: true, indexed: indexed.length, errors: errors.length };
  } catch (err) {
    setSyncError('drive', err.message);
    return { ok: false, error: err.message };
  }
}

function getDocumentsForCuRef(cuRef) {
  return db.prepare('SELECT * FROM drive_index WHERE cu_reference = ?').all(cuRef);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let clickupTimer = null;
let driveTimer = null;

function startBackgroundJobs() {
  refreshClickUpCache();
  refreshDriveIndex();

  clickupTimer = setInterval(refreshClickUpCache, config.clickup.pollIntervalMs);
  driveTimer = setInterval(refreshDriveIndex, config.drive.indexIntervalMs);
}

function stopBackgroundJobs() {
  if (clickupTimer) clearInterval(clickupTimer);
  if (driveTimer) clearInterval(driveTimer);
}

module.exports = {
  refreshClickUpCache,
  refreshDriveIndex,
  getCachedTasks,
  getDocumentsForCuRef,
  startBackgroundJobs,
  stopBackgroundJobs,
};
