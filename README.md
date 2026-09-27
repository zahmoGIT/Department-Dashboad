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
| `config/routing.json` | Per item-type status sequences (mdf/veneer split by gloss vs matt finish, melamine, upholstery, bed-base-upholstered, respray split by finish) - see "Reconciled against ZCreations Full Intelligence" below |
| `config/dashboard.json` | Which ClickUp statuses populate each dashboard column (multi-department hook) |

On the deployed device these are expected at `/etc/depdash/*.json`; override the paths via `DEPDASH_SCHEDULE_CONFIG`, `DEPDASH_ROUTING_CONFIG`, `DEPDASH_DASHBOARD_CONFIG` env vars (see `src/config.js`).

`/etc/depdash/clickup.env` (if present on the device) is loaded automatically and overrides `.env`, so secrets never need to live inside `/opt/depdash`.

## Architecture notes

- **Server-side timers** (`src/timer/manager.js`): time entries are written to ClickUp and to the local `active_timers` SQLite table on scan-in. The browser only displays elapsed time computed from the server record - a power cut never loses timer state. On restart, `resumeFromCrash()` re-reads any still-open timers.
- **Offline queue** (`src/queue/offline.js`): every ClickUp write goes through `tryOrQueue`, which attempts the call directly and, on failure, persists it to `offline_queue` for replay. `/admin` shows queue depth and has a manual "Retry Now".
- **Scan state machine** (`src/scanner/input.js`): global two-scan flow (item -> staff) with a 10s timeout, conflict/take-over handling, and multi-item pause/resume for a carpenter working two items at once. The 5-second "I'm done" confirmation countdown pauses the timer server-side so Cancel can resume it exactly where it left off.
- **Routing** (`src/routing/status.js`): item type is detected from subtask name/description keywords, then the next status is looked up in that type's sequence from `routing.json`. Ambiguous cases return candidate choices for the frontend to prompt.
- **Drive index** (`src/cache/index.js` + `src/api/drive.js`): background job lists both Drive folders, extracts the `00-XXXXX` CU reference from filenames, and stores metadata in `drive_index`. Files that don't match are logged to `drive_index_errors` and surfaced on `/admin`. Documents are proxied/cached on first request under `data/file-cache/`.

## Reconciled against ZCreations Full Intelligence (24 Sep 2026)

This build started from a standalone brief. The ClickUp doc **ZCreations Full Intelligence** (`2e92p-7572`) has two pages that turned out to be more current: **DEPARTMENT DASHBOARDS** (`2e92p-8772`, edited 21 Sep 2026) and **Production Control** (`2e92p-5532`, part of the WIP-PRODUCTION-CONTROL skill, edited 23 Sep 2026 - the more recent of the two, and the authoritative source for production sequences). Cross-checking the app against both surfaced two real bugs, now fixed:

1. **Production sequences were wrong.** The original brief put `assembly wood work` immediately after `wood work` for MDF/veneer items. Production Control's actual sequences put it near the *end* of the pipeline, after primer/paint/stain/top-coats/polishing - `assembly wood work` is the finishing-fit stage (runners, drawer boxes, hardware), not a continuation of raw carpentry. `config/routing.json` and `src/routing/status.js` now encode the real per-material, per-finish (gloss vs matt - matt skips polishing) sequences, including `melamine` and `bed_base_upholstered` as distinct types, and ClickUp's own status is spelled `asembly of upholstery` (no second "s") - matched verbatim so exact-string lookups don't silently fail.
2. **Client name / quote ref could resolve to the wrong task.** Items can be split into component sub-subtasks nested several levels under the real client/quote task (confirmed by the doc's Wendy Gajic example and by spot-checking the live WIP list) - the immediate parent is sometimes a mid-level grouping task like "Upstairs TV room", not "Mohammed wadia QU-5224". `src/api/clickup.js` now climbs the parent chain to the true root, and `src/cache/index.js` extracts quote ref (`QU-XXXX`) separately from CU reference (`00-XXXXX`) instead of reusing the same regex for both.

Also fixed: the ZC Designs/-CODED-/Clients Drive folder holds loose native SolidWorks files (`.SLDPRT`/`.SLDASM`) alongside drawings and cutlists - `src/api/drive.js` now indexes them as `cad_source` instead of logging them as unmatched/naming-error files.

**Confirmed unchanged** (doc matches this build): 30/70 layout, two priority-sorted columns, server-side timers, 5s cancel countdown, ambiguous-status choice prompt, problem categories, both Drive folder IDs, admin page requirements, USB QR scanner approach, item QR before staff QR scan order.

**Known gaps flagged by the doc, intentionally not built yet:**
- Saturday hours in `config/schedule.json` apply shift-wide; the doc notes Saturday is worked by one specific person ("Marvil only"), which would need a per-staff schedule, not just a per-day one.
- A fourth "build notes / construction methodology" document type is mentioned, but the doc itself says that content doesn't exist as a standard practice yet - no Drive source to index, so no tab was added for it.
- Fault/return-to-specific-person routing is more fully specified in the doc (routes back to the original stage's worker specifically, with a defined reassign rule) than the original brief's vague hook. `active_timers.fault_reason`/`returned` already anticipate this but the actual routing-to-person logic and UI are still unbuilt, per the doc's own "hidden from carpenter UI on day one" instruction.
- The doc distinguishes the QR staff badge (per-item attribution only) from ERS Biometrics (separate shift clock-in system) - worth keeping in mind if `staff.clickup_user_id` is ever wired to a real identity source.

## Flexibility hooks already wired (UI hidden, Section 14 of the spec)

- `active_timers.fault_reason` / `returned` columns exist for a future "returned" state.
- `public/js/scanner.js` exposes `window.DepDashScanner.emit(code)` as a generic scan-event entry point - a future NFC/RFID reader adapter calls this directly instead of listening for HID keystrokes.
- `/admin` timer correction endpoint (`POST /api/admin/timers/:id/correct`) already supports manual start/end time fixes.
- `config/routing.json` can be extended with sub-stages without code changes.
- `config/dashboard.json` supports a `staff_filter` field (per-carpenter boards) and a `columns` list (multi-department boards) - same codebase, different config file.

## Deployment (Sige1 / Armbian)

The pilot board's minimal Armbian/Debian image has no desktop environment, so
kiosk mode runs a bare X session (`xinit`/`startx`) rather than assuming a
display manager is present. Both services run as `root`: this board has no
other users, and Chromium's sandbox refuses to start as root anyway
(`--no-sandbox` in `deploy/kiosk-start.sh` is required for that reason) - a
reasonable tradeoff for a single-purpose closed kiosk, not one to make on a
shared machine.

1. `apt install -y xserver-xorg xinit x11-xserver-utils` - the minimal X
   stack the kiosk needs; the Debian `chromium` package (installed earlier)
   already provides the `chromium` binary the services below expect (not
   `chromium-browser`, which is Ubuntu's package name).
2. Copy the repo to `/opt/depdash`, `npm install --production`.
3. Create `/etc/depdash/clickup.env`, `/etc/depdash/drive-credentials.json`, and copies of the three config JSON files under `/etc/depdash/`.
4. Install the systemd units:
   ```bash
   cp deploy/systemd/depdash-backend.service deploy/systemd/depdash-kiosk.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now depdash-backend
   systemctl enable --now depdash-kiosk
   ```
5. Confirm `http://localhost:3000` loads in kiosk mode on boot - check `systemctl status depdash-backend depdash-kiosk` if it doesn't.

## Credentials needed before go-live

- ClickUp API token (`CLICKUP_API_TOKEN`) with access to the WIP list
- Google Cloud service account key with read access to the Job-Sheets and ZC Designs/-CODED-/Clients Drive folders (`GOOGLE_APPLICATION_CREDENTIALS`)
- Staff QR badge codes (ClickUp user IDs or custom codes) - register them in the `staff` SQLite table; unregistered badges are still accepted (logged as a warning) so the floor is never blocked
- `/admin` password (`ADMIN_USERNAME` / `ADMIN_PASSWORD`)
- Sige1 static IP from the router

See `.env.example` for the full list of environment variables.
