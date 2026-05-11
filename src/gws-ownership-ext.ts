/**
 * GWS ownership extension module — Mode A friction primitive (Phase 13.6).
 *
 * This module is OPTIONAL to the base GWS MCP surface. It self-registers
 * on import via:
 *   - `registerPreMutationHook` — gate Drive writes/updates with
 *     `claimOrCheckDriveOwnership` when the resolved principal is
 *     `'instructor-fallback'` (Mode A).
 *   - `registerPostCreateHook` — stamp newly-created files with the
 *     owner tag + anyone-with-link share.
 *   - `registerGwsTool` × 3 — expose
 *     `drive_doc_grant_ownership`, `drive_doc_revoke_ownership`, and
 *     `drive_doc_list_owners` as MCP tools.
 *
 * Trunk does not import this module. It is copied in + wired by the
 * classroom install skill (`/add-classroom-gws`); the skill also
 * appends the `import './gws-ownership-ext.js';` line to `src/index.ts`
 * so it loads at host startup.
 *
 * Mode B note: in Mode B (per-person OAuth, principal === 'self') the
 * hooks short-circuit to no-ops because Google's own auth is the
 * boundary. The three tools still work (they're informational + always
 * permission-checked through the same claim-or-check primitive).
 */
import { getAgentGroup } from './db/agent-groups.js';
import {
  buildDriveClient,
  registerPostCreateHook,
  registerPreMutationHook,
  resolveTokenOrError,
  type ToolContext,
  type ToolError,
} from './gws-mcp-tools.js';
import { registerGwsTool } from './gws-mcp-server.js';
import {
  claimOrCheckDriveOwnership,
  formatHardBlockMessage,
  readDriveOwners,
  stampNewDriveFile,
  writeDriveOwners,
} from './gws-ownership.js';
import { log } from './log.js';

export interface OwnershipChangeResult {
  ok: true;
  fileId: string;
  owners: string[];
  changed: boolean;
}

export interface OwnerInfo {
  agent_group_id: string;
  display_name: string | null;
}

export interface ListOwnersResult {
  ok: true;
  fileId: string;
  owners: OwnerInfo[];
}

// ────────────────────────────────────────────────────────────────────
// Tool handlers
// ────────────────────────────────────────────────────────────────────

/**
 * Add an agent group to a Drive file's NanoClaw owners list. Caller
 * must already be an owner (or be claiming an untagged file via
 * first-touch — same semantics as `driveDocWriteFromMarkdown`'s
 * pre-flight). No-op when target is already in the list.
 */
export async function driveGrantOwnership(
  ctx: ToolContext,
  args: { file_id: string; agent_group_id: string },
): Promise<OwnershipChangeResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  if (!ctx.agentGroupId) {
    return {
      ok: false,
      error: 'drive_doc_grant_ownership requires an attributed caller (X-NanoClaw-Agent-Group header).',
      status: 400,
    };
  }

  const check = await claimOrCheckDriveOwnership(drive, args.file_id, ctx.agentGroupId);
  if (!check.ok) return check;

  if (check.owners.includes(args.agent_group_id)) {
    return { ok: true, fileId: args.file_id, owners: check.owners, changed: false };
  }
  const newOwners = [...check.owners, args.agent_group_id];
  try {
    await writeDriveOwners(drive, args.file_id, newOwners);
  } catch (err) {
    log.warn('drive_doc_grant_ownership: writeDriveOwners failed', { fileId: args.file_id, err: String(err) });
    return {
      ok: false,
      error: `Failed to update owners on ${args.file_id}: ${(err as Error).message}`,
      status: 500,
    };
  }
  return { ok: true, fileId: args.file_id, owners: newOwners, changed: true };
}

/**
 * Remove an agent group from a Drive file's owners list. Caller must
 * be an owner. Refuses if the removal would leave the file with no
 * owners (an unowned file becomes claim-able by the next writer).
 */
export async function driveRevokeOwnership(
  ctx: ToolContext,
  args: { file_id: string; agent_group_id: string },
): Promise<OwnershipChangeResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  if (!ctx.agentGroupId) {
    return {
      ok: false,
      error: 'drive_doc_revoke_ownership requires an attributed caller (X-NanoClaw-Agent-Group header).',
      status: 400,
    };
  }

  let owners: string[];
  try {
    owners = await readDriveOwners(drive, args.file_id);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read owners on ${args.file_id}: ${(err as Error).message}`,
      status: 500,
    };
  }

  if (owners.length === 0) {
    return {
      ok: false,
      error: `File ${args.file_id} has no NanoClaw owner tag — nothing to revoke.`,
      status: 404,
    };
  }
  if (!owners.includes(ctx.agentGroupId)) {
    return {
      ok: false,
      error: formatHardBlockMessage(args.file_id, owners),
      status: 403,
    };
  }
  if (!owners.includes(args.agent_group_id)) {
    return { ok: true, fileId: args.file_id, owners, changed: false };
  }
  const newOwners = owners.filter((o) => o !== args.agent_group_id);
  if (newOwners.length === 0) {
    return {
      ok: false,
      error: `Refusing to revoke last owner of ${args.file_id} — grant ownership to another agent first.`,
      status: 409,
    };
  }
  try {
    await writeDriveOwners(drive, args.file_id, newOwners);
  } catch (err) {
    log.warn('drive_doc_revoke_ownership: writeDriveOwners failed', { fileId: args.file_id, err: String(err) });
    return {
      ok: false,
      error: `Failed to update owners on ${args.file_id}: ${(err as Error).message}`,
      status: 500,
    };
  }
  return { ok: true, fileId: args.file_id, owners: newOwners, changed: true };
}

/**
 * Read the owners list of a Drive file with display names resolved.
 * No permission check — ownership lookup is informational.
 */
export async function driveListOwners(
  ctx: ToolContext,
  args: { file_id: string },
): Promise<ListOwnersResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  let owners: string[];
  try {
    owners = await readDriveOwners(drive, args.file_id);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read owners on ${args.file_id}: ${(err as Error).message}`,
      status: 500,
    };
  }
  return {
    ok: true,
    fileId: args.file_id,
    owners: owners.map((agId) => ({
      agent_group_id: agId,
      display_name: getAgentGroup(agId)?.name ?? null,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────
// Validators (used by registerGwsTool entries below)
// ────────────────────────────────────────────────────────────────────

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function asString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function validateOwnershipChange(raw: unknown): { file_id: string; agent_group_id: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const fileId = asString(o, 'file_id');
  if (!fileId) return '`file_id` (string) is required';
  const agentGroupId = asString(o, 'agent_group_id');
  if (!agentGroupId) return '`agent_group_id` (string) is required';
  return { file_id: fileId, agent_group_id: agentGroupId };
}

function validateListOwners(raw: unknown): { file_id: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const fileId = asString(o, 'file_id');
  if (!fileId) return '`file_id` (string) is required';
  return { file_id: fileId };
}

// ────────────────────────────────────────────────────────────────────
// Self-registration (the side-effect that makes this an ext module)
// ────────────────────────────────────────────────────────────────────

registerPreMutationHook(async ({ drive, fileId, ctx, resolved }) => {
  if (resolved.principal !== 'instructor-fallback') return { ok: true };
  if (!ctx.agentGroupId) return { ok: true };
  return claimOrCheckDriveOwnership(drive, fileId, ctx.agentGroupId);
});

registerPostCreateHook(async ({ drive, fileId, ctx, resolved }) => {
  if (resolved.principal !== 'instructor-fallback') return;
  if (!ctx.agentGroupId) return;
  await stampNewDriveFile(drive, fileId, ctx.agentGroupId);
});

registerGwsTool('drive_doc_grant_ownership', {
  handler: driveGrantOwnership,
  validate: validateOwnershipChange as (raw: unknown) => unknown | string,
});
registerGwsTool('drive_doc_revoke_ownership', {
  handler: driveRevokeOwnership,
  validate: validateOwnershipChange as (raw: unknown) => unknown | string,
});
registerGwsTool('drive_doc_list_owners', {
  handler: driveListOwners,
  validate: validateListOwners as (raw: unknown) => unknown | string,
});
