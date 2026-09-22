# Department Dashboard (DepDash)

Factory floor kiosk dashboard for the ZCreations Woodwork department pilot. Runs on an ArmSoM Sige1 (ARM64, Armbian), displays active ClickUp woodwork tasks, shows job-sheet/cutlist/drawing documents from Google Drive, tracks per-item production time via QR scanning, and writes status/time changes back to ClickUp.

## Stack

- Node.js + Express backend, SQLite (better-sqlite3) local cache/queue
- Vanilla JS frontend (no framework), dark theme, kiosk-friendly
- ClickUp API v2, Google Drive API v3 (service account)
- Chromium kiosk mode via systemd on the target device

## Local development

```bash
npm install
cp .env.example .env   # fill in ClickUp token, Drive credentials path, etc.
npm run dev
```

Without a real `CLICKUP_API_TOKEN` / Drive credentials, the server still starts; the ClickUp poll and Drive index refresh will simply log errors to `error_log` (visible on `/admin`) and the dashboard will show no cards until valid credentials are supplied.

Dashboard: `http://localhost:3000/`
Admin: `http://localhost:3000/admin` (HTTP Basic Auth - `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`)

## Configuration files

| File | Purpose |
|---|---|
| `config/schedule.json` | Shift times, lunch, working days, Saturday hours, public holidays - used to compute production time net of non-working hours |
| `config/routing.json` | Per item-type status sequences (mdf / veneer / upholstery / respray) |
| `config/dashboard.json` | Which ClickUp statuses populate each dashboard column (multi-department hook) |

On the deployed device these are expected at `/etc/depdash/*.json`; override the paths via `DEPDASH_SCHEDULE_CONFIG`, `DEPDASH_ROUTING_CONFIG`, `DEPDASH_DASHBOARD_CONFIG` env vars (see `src/config.js`).

`/etc/depdash/clickup.env` (if present on the device) is loaded automatically and overrides `.env`, so secrets never need to live inside `/opt/depdash`.

## Architecture notes

- **Server-side timers** (`src/timer/manager.js`): time entries are written to ClickUp and to the local `active_timers` SQLite table on scan-in. The browser only displays elapsed time computed from the server record - a power cut never loses timer state. On restart, `resumeFromCrash()` re-reads any still-open timers.
- **Offline queue** (`src/queue/offline.js`): every ClickUp write goes through `tryOrQueue`, which attempts the call directly and, on failure, persists it to `offline_queue` for replay. `/admin` shows queue depth and has a manual "Retry Now".
- **Scan state machine** (`src/scanner/input.js`): global two-scan flow (item -> staff) with a 10s timeout, conflict/take-over handling, and multi-item pause/resume for a carpenter working two items at once. The 5-second "I'm done" confirmation countdown pauses the timer server-side so Cancel can resume it exactly where it left off.
- **Routing** (`src/routing/status.js`): item type is detected from subtask name/description keywords, then the next status is looked up in that type's sequence from `routing.json`. Ambiguous cases return candidate choices for the frontend to prompt.
- **Drive index** (`src/cache/index.js` + `src/api/drive.js`): background job lists both Drive folders, extracts the `00-XXXXX` CU reference from filenames, and stores metadata in `drive_index`. Files that don't match are logged to `drive_index_errors` and surfaced on `/admin`. Documents are proxied/cached on first request under `data/file-cache/`.

## Flexibility hooks already wired (UI hidden, Section 14 of the spec)

- `active_timers.fault_reason` / `returned` columns exist for a future "returned" state.
- `public/js/scanner.js` exposes `window.DepDashScanner.emit(code)` as a generic scan-event entry point - a future NFC/RFID reader adapter calls this directly instead of listening for HID keystrokes.
- `/admin` timer correction endpoint (`POST /api/admin/timers/:id/correct`) already supports manual start/end time fixes.
- `config/routing.json` can be extended with sub-stages without code changes.
- `config/dashboard.json` supports a `staff_filter` field (per-carpenter boards) and a `columns` list (multi-department boards) - same codebase, different config file.

## Deployment (Sige1 / Armbian)

1. Copy the repo to `/opt/depdash`, `npm install --production`.
2. Create `/etc/depdash/clickup.env`, `/etc/depdash/drive-credentials.json`, and copies of the three config JSON files under `/etc/depdash/`.
3. Install the systemd units:
   ```bash
   sudo cp deploy/systemd/depdash-backend.service deploy/systemd/depdash-kiosk.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now depdash-backend depdash-kiosk
   ```
4. Confirm `http://localhost:3000` loads in kiosk mode on boot.

## Credentials needed before go-live

- ClickUp API token (`CLICKUP_API_TOKEN`) with access to the WIP list
- Google Cloud service account key with read access to the Job-Sheets and ZC Designs/-CODED-/Clients Drive folders (`GOOGLE_APPLICATION_CREDENTIALS`)
- Staff QR badge codes (ClickUp user IDs or custom codes) - register them in the `staff` SQLite table; unregistered badges are still accepted (logged as a warning) so the floor is never blocked
- `/admin` password (`ADMIN_USERNAME` / `ADMIN_PASSWORD`)
- Sige1 static IP from the router

See `.env.example` for the full list of environment variables.
