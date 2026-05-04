/**
 * Host-side Drive operations for the class feature.
 *
 * Uses the instructor's existing Google OAuth credentials (left behind by
 * the `taylorwilsdon/google_workspace_mcp` install at `~/.config/gws/`) to
 * create per-student Drive folders inside the configured parent folder
 * and share them with each student's email.
 *
 * Why host-side: the OAuth refresh token grants full Drive access. Mounting
 * it into student containers would let any student's container see the
 * instructor's whole Drive. Phase 3c will expose a folder-scoped MCP tool
 * to the container; this module is the building block it'll call.
 *
 * No retry logic — Drive failures bubble up to the pair handler, which
 * logs the error and lets the pairing succeed anyway. The student can
 * re-pair (idempotent) once the underlying issue is fixed.
 */
import fs from 'fs';
import path from 'path';

import { google, drive_v3, type Auth } from 'googleapis';

import { log } from './log.js';

const GWS_CONFIG_DIR = path.join(process.env.HOME || '/home/nano', '.config', 'gws');
const CREDENTIALS_PATH = path.join(GWS_CONFIG_DIR, 'credentials.json');

interface StoredCredentials {
  type: string;
  client_id: string;
  client_secret: string;
  access_token?: string;
  refresh_token: string;
  token_type?: string;
  expiry_date?: number;
  scope?: string;
}

let cachedDrive: drive_v3.Drive | null = null;

function loadCredentials(): StoredCredentials {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Google OAuth credentials not found at ${CREDENTIALS_PATH}. ` +
        `Authorize via /add-gmail-tool or /add-gcal-tool first.`,
    );
  }
  const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
  if (!parsed.refresh_token || !parsed.client_id || !parsed.client_secret) {
    throw new Error(
      `Google OAuth credentials at ${CREDENTIALS_PATH} are incomplete (missing refresh_token / client_id / client_secret).`,
    );
  }
  return parsed as StoredCredentials;
}

function getDriveClient(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const creds = loadCredentials();
  const oauth2: Auth.OAuth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  oauth2.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
    expiry_date: creds.expiry_date,
    token_type: creds.token_type,
    scope: creds.scope,
  });
  cachedDrive = google.drive({ version: 'v3', auth: oauth2 });
  return cachedDrive;
}

export interface CreateStudentFolderOpts {
  parentFolderId: string;
  studentFolder: string;
  studentName: string;
  studentEmail: string;
}

export interface StudentFolderResult {
  folderId: string;
  folderUrl: string;
  created: boolean;
  shared: boolean;
}

/**
 * Create (or reuse) a Drive folder named "<studentFolder> — <studentName>"
 * inside `parentFolderId`, then share it with `studentEmail` as writer.
 *
 * Idempotent on both axes: if a folder with the same name already exists
 * under the parent, reuse it. If the email already has a permission on
 * the folder, don't re-grant.
 */
export async function createStudentFolder(opts: CreateStudentFolderOpts): Promise<StudentFolderResult> {
  const drive = getDriveClient();
  const folderName = `${opts.studentFolder} — ${opts.studentName}`;

  // 1. Look for an existing folder with this name under the parent.
  const escaped = folderName.replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `'${opts.parentFolderId}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, webViewLink)',
    pageSize: 1,
    spaces: 'drive',
  });
  let folderId: string;
  let folderUrl: string;
  let created: boolean;
  if (existing.data.files && existing.data.files.length > 0) {
    folderId = existing.data.files[0].id!;
    folderUrl = existing.data.files[0].webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`;
    created = false;
    log.info('class-drive: reusing existing folder', { folderId, folderName });
  } else {
    const createRes = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [opts.parentFolderId],
      },
      fields: 'id, webViewLink',
    });
    folderId = createRes.data.id!;
    folderUrl = createRes.data.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}`;
    created = true;
    log.info('class-drive: folder created', { folderId, folderName });
  }

  // 2. Check existing permissions; only grant if the student isn't already on it.
  const perms = await drive.permissions.list({
    fileId: folderId,
    fields: 'permissions(id, emailAddress, role)',
  });
  const alreadyShared = (perms.data.permissions ?? []).some(
    (p) => p.emailAddress?.toLowerCase() === opts.studentEmail.toLowerCase(),
  );
  let shared = false;
  if (!alreadyShared) {
    await drive.permissions.create({
      fileId: folderId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: opts.studentEmail,
      },
      // We send our own welcome message via Telegram — Google's notification
      // would arrive before the student even pairs in some flows, and adds
      // confusion. Suppress.
      sendNotificationEmail: false,
    });
    shared = true;
    log.info('class-drive: shared folder with student', { folderId, email: opts.studentEmail });
  }

  return { folderId, folderUrl, created, shared };
}

/** Test hook — reset the cached drive client (e.g. after rotating creds). */
export function _resetClientForTest(): void {
  cachedDrive = null;
}
