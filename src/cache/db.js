const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
fs.mkdirSync(config.fileCacheDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS drive_index (
    cu_reference TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,            -- job_sheet | cutlist | drawing
    folder_source TEXT NOT NULL,
    mime_type TEXT,
    last_modified TEXT,
    download_url TEXT,
    PRIMARY KEY (file_id)
  );
  CREATE INDEX IF NOT EXISTS idx_drive_index_cu ON drive_index(cu_reference);

  CREATE TABLE IF NOT EXISTS drive_index_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_id TEXT,
    folder_source TEXT,
    reason TEXT NOT NULL,
    detected_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Server-side timer state (Section 6). Survives power loss: on restart the
  -- backend re-reads this table and treats any row with no ended_at as still
  -- running, per ClickUp's own record.
  CREATE TABLE IF NOT EXISTS active_timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,              -- ClickUp task id
    cu_reference TEXT,
    staff_id TEXT NOT NULL,
    staff_name TEXT,
    clickup_time_entry_id TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    paused_at TEXT,                     -- non-null while paused (multi-task handling)
    total_paused_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',  -- running | paused | stopped
    fault_reason TEXT,                  -- flexibility hook: Section 14.1 "returned" state
    returned INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_active_timers_item ON active_timers(item_id, status);
  CREATE INDEX IF NOT EXISTS idx_active_timers_staff ON active_timers(staff_id, status);

  CREATE TABLE IF NOT EXISTS offline_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    operation_type TEXT NOT NULL,       -- status_change | time_entry_start | time_entry_stop | comment
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    synced_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_offline_queue_status ON offline_queue(status);

  -- Local cache of the ClickUp task list so the UI has instant data and can
  -- keep working (read-only) if ClickUp is unreachable.
  CREATE TABLE IF NOT EXISTS tasks_cache (
    task_id TEXT PRIMARY KEY,
    parent_task_id TEXT,
    cu_reference TEXT,
    client_name TEXT,
    quote_ref TEXT,
    item_name TEXT,
    status TEXT,
    priority TEXT,
    due_date TEXT,
    assignee_json TEXT,
    description TEXT,
    attachment_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    raw_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    level TEXT NOT NULL DEFAULT 'error', -- error | warning
    source TEXT NOT NULL,
    message TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_status (
    key TEXT PRIMARY KEY,
    last_success_at TEXT,
    last_error_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS staff (
    staff_id TEXT PRIMARY KEY,          -- QR badge content (ClickUp user id or custom code)
    name TEXT NOT NULL,
    clickup_user_id TEXT
  );
`);

function logError(source, message, level = 'error') {
  db.prepare('INSERT INTO error_log (source, message, level) VALUES (?, ?, ?)').run(source, message, level);
  const keep = 500;
  db.prepare(`
    DELETE FROM error_log WHERE id NOT IN (
      SELECT id FROM error_log ORDER BY id DESC LIMIT ?
    )
  `).run(keep);
}

function setSyncSuccess(key) {
  db.prepare(`
    INSERT INTO sync_status (key, last_success_at) VALUES (?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET last_success_at = datetime('now')
  `).run(key);
}

function setSyncError(key, message) {
  db.prepare(`
    INSERT INTO sync_status (key, last_error_at, last_error) VALUES (?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET last_error_at = datetime('now'), last_error = excluded.last_error
  `).run(key, message);
  logError(key, message);
}

module.exports = { db, logError, setSyncSuccess, setSyncError };
