const fs = require('fs');
const { google } = require('googleapis');
const config = require('../config');

const CU_REF_REGEX = /00-\d{5}/;

let driveClient = null;

function getDriveClient() {
  if (driveClient) return driveClient;
  if (!fs.existsSync(config.drive.credentialsPath)) {
    throw new Error(`Google Drive credentials not found at ${config.drive.credentialsPath}`);
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: config.drive.credentialsPath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Classify a file within the "cutlist/drawing" folder. Drawings are the
 * SolidWorks-exported 2D PDFs; cutlists are spreadsheets (or PDF exports of
 * one). We use filename keywords first, falling back to mime type.
 */
function classifyCutlistOrDrawing(fileName, mimeType) {
  const lower = fileName.toLowerCase();
  if (lower.includes('drawing') || lower.includes('dwg')) return 'drawing';
  if (lower.includes('cutlist') || lower.includes('cut list')) return 'cutlist';
  if (mimeType === 'application/vnd.google-apps.spreadsheet' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    return 'cutlist';
  }
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) return 'drawing';
  return null;
}

/**
 * List every file in a Drive folder (single level, non-recursive per spec).
 * Handles pagination.
 */
async function listFolderFiles(folderId) {
  const drive = getDriveClient();
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, webContentLink)',
      pageSize: 200,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

/**
 * Build the full index: job sheets folder (all treated as job_sheet type)
 * and the cutlist/drawing folder (classified per file). Returns
 * { indexed: [...], errors: [...] } for the caller to persist.
 */
async function buildDriveIndex() {
  const indexed = [];
  const errors = [];

  const jobSheetFiles = await listFolderFiles(config.drive.jobSheetsFolderId);
  for (const f of jobSheetFiles) {
    const match = f.name.match(CU_REF_REGEX);
    if (!match) {
      errors.push({ file_name: f.name, file_id: f.id, folder_source: 'job_sheets', reason: 'No CU reference (00-XXXXX) found in filename' });
      continue;
    }
    indexed.push({
      cu_reference: match[0],
      file_id: f.id,
      file_name: f.name,
      file_type: 'job_sheet',
      folder_source: 'job_sheets',
      mime_type: f.mimeType,
      last_modified: f.modifiedTime,
      download_url: f.webContentLink || f.webViewLink || null,
    });
  }

  const codedFiles = await listFolderFiles(config.drive.cutlistDrawingFolderId);
  for (const f of codedFiles) {
    const match = f.name.match(CU_REF_REGEX);
    if (!match) {
      errors.push({ file_name: f.name, file_id: f.id, folder_source: 'coded_clients', reason: 'No CU reference (00-XXXXX) found in filename' });
      continue;
    }
    const fileType = classifyCutlistOrDrawing(f.name, f.mimeType);
    if (!fileType) {
      errors.push({ file_name: f.name, file_id: f.id, folder_source: 'coded_clients', reason: `Could not classify as cutlist or drawing (mimeType=${f.mimeType})` });
      continue;
    }
    indexed.push({
      cu_reference: match[0],
      file_id: f.id,
      file_name: f.name,
      file_type: fileType,
      folder_source: 'coded_clients',
      mime_type: f.mimeType,
      last_modified: f.modifiedTime,
      download_url: f.webContentLink || f.webViewLink || null,
    });
  }

  return { indexed, errors };
}

/** Stream a file's binary content, used to serve/cache PDFs and spreadsheets. */
async function downloadFile(fileId, mimeType) {
  const drive = getDriveClient();
  if (mimeType && mimeType.startsWith('application/vnd.google-apps')) {
    // Google-native file (Sheet/Doc) - export as PDF for embedding.
    const res = await drive.files.export(
      { fileId, mimeType: 'application/pdf' },
      { responseType: 'stream' }
    );
    return { stream: res.data, mimeType: 'application/pdf' };
  }
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  return { stream: res.data, mimeType: mimeType || 'application/octet-stream' };
}

module.exports = { buildDriveIndex, downloadFile, CU_REF_REGEX };
