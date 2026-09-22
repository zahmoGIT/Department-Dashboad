const fs = require('fs');
const path = require('path');
require('dotenv').config();

// On the Sige1 deployment, /etc/depdash/clickup.env holds the real secrets.
// Locally, .env (see .env.example) is used instead. If the system file
// exists, its values win (deployment is the source of truth on-device).
const SYSTEM_ENV_FILE = '/etc/depdash/clickup.env';
if (fs.existsSync(SYSTEM_ENV_FILE)) {
  require('dotenv').config({ path: SYSTEM_ENV_FILE, override: true });
}

function readJson(envVar, fallbackRelPath) {
  const filePath = process.env[envVar] || path.join(__dirname, '..', fallbackRelPath);
  try {
    return { data: JSON.parse(fs.readFileSync(filePath, 'utf8')), path: filePath };
  } catch (err) {
    throw new Error(`Failed to load config file ${filePath} (from ${envVar}): ${err.message}`);
  }
}

const schedule = readJson('DEPDASH_SCHEDULE_CONFIG', 'config/schedule.json');
const routing = readJson('DEPDASH_ROUTING_CONFIG', 'config/routing.json');
const dashboard = readJson('DEPDASH_DASHBOARD_CONFIG', 'config/dashboard.json');

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  clickup: {
    apiToken: process.env.CLICKUP_API_TOKEN || '',
    teamId: process.env.CLICKUP_TEAM_ID || '',
    wipListId: process.env.CLICKUP_WIP_LIST_ID || '',
    notifyUserIds: (process.env.CLICKUP_NOTIFY_USER_IDS || '4669371,93847871')
      .split(',').map((s) => s.trim()).filter(Boolean),
    pollIntervalMs: parseInt(process.env.CLICKUP_POLL_INTERVAL_MS, 10) || 30000,
  },

  drive: {
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/depdash/drive-credentials.json',
    jobSheetsFolderId: process.env.DRIVE_JOB_SHEETS_FOLDER_ID || '1X71HbOoQw6hpgA6xirrfB81VIypA_1H4',
    cutlistDrawingFolderId: process.env.DRIVE_CUTLIST_DRAWING_FOLDER_ID || '1ffYzLYZII5S4BL_9U8XFPNB7G6l71RFc',
    indexIntervalMs: parseInt(process.env.DRIVE_INDEX_INTERVAL_MS, 10) || 300000,
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'change-me',
  },

  dbPath: process.env.DEPDASH_DB_PATH || path.join(__dirname, '..', 'data', 'depdash.sqlite'),
  fileCacheDir: path.join(__dirname, '..', 'data', 'file-cache'),

  schedule: schedule.data,
  routing: routing.data,
  dashboardConfig: dashboard.data,
  configPaths: {
    schedule: schedule.path,
    routing: routing.path,
    dashboard: dashboard.path,
  },
};
