/**
 * NanoClaw ownership tagging for Drive files.
 *
 * Mode A (shared class workspace, one OAuth bearer for everyone) has
 * no Google-level boundary between students — every file is owned by
 * the workspace account regardless of who created it. We layer
 * NanoClaw-side ownership on top: every file NanoClaw mutates is
 * tagged via Drive `customProperties` with a comma-separated list of
 * agent_group_ids that "own" it. Subsequent writes / deletes against
 * the file are hard-blocked unless the caller's agent group is in
 * that list.
 *
 * In Mode B (per-person OAuth), each user's bearer scopes their
 * Drive access through Google's own auth — this code's check is
 * redundant. Callers skip it by checking the resolved principal.
 *
 * Untagged files (e.g., created outside NanoClaw via the Drive web
 * UI) get claimed by the first NanoClaw agent that writes them
 * ("claim on first touch"). The intent: students collaborate freely
 * outside NanoClaw, but once a file is in NanoClaw's flow the
 * friction kicks in.
 *
 * Storage: Drive `customProperties` (visible to anyone with file
 * access). Comma-separated `agent_group_id` values under the key
 * `nanoclaw_owners`. Max 124 chars per Drive property value → ~12
 * owners with short ag_* ids; sufficient for class workflows.
 */
import { drive as driveApi } from '@googleapis/drive';

import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';

type DriveClient = ReturnType<typeof driveApi>;

export const OWNERS_PROPERTY = 'nanoclaw_owners';

export interface OwnershipBlocked {
  ok: false;
  error: string;
  status: 403;
}

export interface OwnershipCleared {
  ok: true;
  owners: string[];
  claimed: boolean;
}

export type OwnershipCheckResult = OwnershipBlocked | OwnershipCleared;

/**
 * Read the current owners list from a Drive file's customProperties.
 * Returns an empty array when the tag is missing (untagged file).
 * Throws on Drive API failure — caller decides whether to treat that
 * as a soft "untagged" or surface the error.
 */
export async function readDriveOwners(drive: DriveClient, fileId: string): Promise<string[]> {
  const res = await drive.files.get({ fileId, fields: 'properties' });
  const raw = res.data.properties?.[OWNERS_PROPERTY];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Write an owners list to a file. Throws if `owners` is empty —
 * an empty list would mean "unowned," which we don't model (the
 * tag would just disappear and the file becomes claim-able by
 * anyone on next touch). `revokeOwnership` is the path that must
 * guard against this.
 */
export async function writeDriveOwners(drive: DriveClient, fileId: string, owners: string[]): Promise<void> {
  if (owners.length === 0) {
    throw new Error('writeDriveOwners: owners list cannot be empty');
  }
  await drive.files.update({
    fileId,
    requestBody: { properties: { [OWNERS_PROPERTY]: owners.join(',') } },
  });
}

/**
 * Format a hard-block error message that names the file's current
 * owners by display name, so students aren't faced with raw
 * agent_group_ids.
 */
export function formatHardBlockMessage(fileId: string, owners: string[]): string {
  const names = owners.map((agId) => {
    const ag = getAgentGroup(agId);
    return ag?.name ?? `${agId} (unknown)`;
  });
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return (
    `Blocked: this file is owned by ${list}. ` +
    `Ask one of them to share write access via drive_doc_grant_ownership, or to make the change themselves.`
  );
}

/**
 * Gate a write/delete on a Drive file:
 *   - If untagged → claim it for the caller (write the tag), return cleared.
 *   - If caller already in owners → return cleared.
 *   - Otherwise → return hard-block error with display names.
 *
 * Read failures (e.g., 404 because file doesn't exist yet) are
 * treated as "untagged + don't try to claim" so the caller's
 * downstream operation (which will also 404 or fall through to
 * create) surfaces the real error. The create path is responsible
 * for stamping the newly created file via `stampNewDriveFile`.
 */
export async function claimOrCheckDriveOwnership(
  drive: DriveClient,
  fileId: string,
  callerAgentGroupId: string,
): Promise<OwnershipCheckResult> {
  let owners: string[];
  try {
    owners = await readDriveOwners(drive, fileId);
  } catch (err) {
    log.debug('claimOrCheckDriveOwnership: read failed, treating as untagged', {
      fileId,
      err: String(err),
    });
    return { ok: true, owners: [], claimed: false };
  }

  if (owners.length === 0) {
    try {
      await writeDriveOwners(drive, fileId, [callerAgentGroupId]);
    } catch (err) {
      log.warn('claimOrCheckDriveOwnership: claim write failed (proceeding anyway)', {
        fileId,
        err: String(err),
      });
    }
    return { ok: true, owners: [callerAgentGroupId], claimed: true };
  }

  if (owners.includes(callerAgentGroupId)) {
    return { ok: true, owners, claimed: false };
  }

  return {
    ok: false,
    error: formatHardBlockMessage(fileId, owners),
    status: 403,
  };
}

/**
 * Post-create stamp: set initial owner tag and apply
 * anyone-with-link writer share so students can open the file via
 * their personal-email web login.
 *
 * Best-effort — failures to stamp the tag are logged but not
 * surfaced as tool errors (the file exists; the operation
 * effectively succeeded; future writes will just claim-on-first-touch).
 * Failures to apply sharing are also best-effort because some
 * Drive configurations restrict external sharing — the tool returns
 * the fileId regardless so the caller can decide.
 */
export async function stampNewDriveFile(
  drive: DriveClient,
  fileId: string,
  creatorAgentGroupId: string,
): Promise<void> {
  try {
    await writeDriveOwners(drive, fileId, [creatorAgentGroupId]);
  } catch (err) {
    log.warn('stampNewDriveFile: writeDriveOwners failed', { fileId, err: String(err) });
  }
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { type: 'anyone', role: 'writer' },
    });
  } catch (err) {
    log.warn('stampNewDriveFile: anyone-with-link share failed', { fileId, err: String(err) });
  }
}
