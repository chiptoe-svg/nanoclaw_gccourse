/**
 * Google Workspace MCP tools — V1 surface (Phase 13.2).
 *
 * Two tools that close the gap rclone leaves: rclone makes Drive files
 * look like a normal filesystem (great for bash + Read/Write), but
 * binary `.gdoc` pointers aren't editable. These tools give agents
 * editable text:
 *
 *   - `drive_doc_read_as_markdown(file_id)` — fetches a Google Doc and
 *     exports it as markdown via the Drive `export` endpoint. Returns
 *     the markdown string.
 *   - `drive_doc_write_from_markdown(file_id, markdown, opts?)` —
 *     overwrites an existing Doc's content with the supplied markdown,
 *     using Drive's `update` endpoint with mimeType conversion. With
 *     `create_if_missing: true` and a parent folder, will create a new
 *     Doc instead.
 *
 * Path-based lookup ("find a Doc named X under student folder Y") is
 * deferred — V1 takes file_ids only. Path resolution would land via
 * `@googleapis/drive`'s `files.list` with a `q=` query; tracked for a
 * V2 follow-up.
 *
 * OAuth: each tool resolves its access token via
 * `getGoogleAccessTokenForAgentGroup(agentGroupId)` so per-student
 * isolation Just Works once the class deployment wires it.
 */
import { Readable } from 'stream';

import { drive as driveApi, auth as gAuth } from '@googleapis/drive';

import { getAgentGroup } from './db/agent-groups.js';
import {
  claimOrCheckDriveOwnership,
  formatHardBlockMessage,
  readDriveOwners,
  stampNewDriveFile,
  writeDriveOwners,
} from './gws-ownership.js';
import { getGoogleAccessTokenForAgentGroup, type GwsPrincipal } from './gws-token.js';
import { log } from './log.js';

export interface ToolContext {
  agentGroupId: string | null;
}

export interface ToolError {
  ok: false;
  error: string;
  status?: number;
}

export interface DocReadResult {
  ok: true;
  fileId: string;
  markdown: string;
  bytes: number;
}

export interface DocWriteResult {
  ok: true;
  fileId: string;
  bytes: number;
  created: boolean;
}

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

function buildDriveClient(accessToken: string): ReturnType<typeof driveApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return driveApi({ version: 'v3', auth: oauth });
}

interface ResolvedToken {
  token: string;
  principal: GwsPrincipal;
}

type DriveClient = ReturnType<typeof driveApi>;

/**
 * Extension hook context: passed to pre-mutation / post-create hooks so
 * extensions (e.g., classroom Mode A ownership) can decide whether to
 * fire based on principal / agentGroupId without re-resolving anything.
 */
export interface HookContext {
  drive: DriveClient;
  fileId: string;
  ctx: ToolContext;
  resolved: ResolvedToken;
}

/**
 * Pre-mutation hook: runs before a Drive write/update. Return
 * `{ ok: true }` to allow, `ToolError` to block (returned to caller
 * verbatim — status preserved). Extra ok fields are tolerated.
 */
export type PreMutationHook = (h: HookContext) => Promise<{ ok: true } | ToolError>;

/**
 * Post-create hook: runs after a successful `files.create` (e.g., on
 * the create-if-missing fallback). Best-effort — exceptions are
 * swallowed so they don't fail the user-visible "file was created"
 * result. Extensions: ownership tag stamping, anyone-with-link share.
 */
export type PostCreateHook = (h: HookContext) => Promise<void>;

const preMutationHooks: PreMutationHook[] = [];
const postCreateHooks: PostCreateHook[] = [];

/** Register a hook that runs before any Drive write/update. */
export function registerPreMutationHook(hook: PreMutationHook): void {
  preMutationHooks.push(hook);
}

/** Register a hook that runs after a successful Drive create. */
export function registerPostCreateHook(hook: PostCreateHook): void {
  postCreateHooks.push(hook);
}

/** Test hook — drop all registered hooks. Used by extension tests. */
export function _resetHooksForTest(): void {
  preMutationHooks.length = 0;
  postCreateHooks.length = 0;
}

async function resolveTokenOrError(ctx: ToolContext): Promise<ResolvedToken | ToolError> {
  const resolved = await getGoogleAccessTokenForAgentGroup(ctx.agentGroupId);
  if (!resolved) {
    return {
      ok: false,
      error:
        'No Google OAuth token available — instructor needs ~/.config/gws/credentials.json or the student needs to complete /add-classroom-auth.',
      status: 502,
    };
  }
  return resolved;
}

/**
 * Drive `export` endpoint converts a Google Doc to a chosen mimeType
 * server-side. `text/markdown` is officially supported. Returns the
 * markdown text directly.
 */
export async function driveDocReadAsMarkdown(
  ctx: ToolContext,
  args: { file_id: string },
): Promise<DocReadResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  try {
    const res = await drive.files.export({ fileId: args.file_id, mimeType: 'text/markdown' }, { responseType: 'text' });
    const markdown = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    return { ok: true, fileId: args.file_id, markdown, bytes: Buffer.byteLength(markdown) };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    log.warn('drive_doc_read_as_markdown failed', { fileId: args.file_id, status, err: String(err) });
    return {
      ok: false,
      error: `Drive export failed for ${args.file_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Drive `update` (with mimeType conversion) replaces a Google Doc's
 * content in-place — Drive accepts `text/markdown` as the source
 * media and stores the result as `application/vnd.google-apps.document`.
 *
 * With `opts.create_if_missing` + `opts.parent_folder_id` set and the
 * file_id missing on Drive, falls through to `files.create` instead so
 * a single tool call can do "make-or-update."
 */
export async function driveDocWriteFromMarkdown(
  ctx: ToolContext,
  args: {
    file_id: string;
    markdown: string;
    create_if_missing?: boolean;
    parent_folder_id?: string;
    name?: string;
  },
): Promise<DocWriteResult | ToolError> {
  const tokenOrError = await resolveTokenOrError(ctx);
  if (!('principal' in tokenOrError)) return tokenOrError;
  const drive = buildDriveClient(tokenOrError.token);

  // Pre-mutation hooks (registered by extensions, e.g., classroom Mode A
  // ownership). Each hook decides internally whether to fire based on
  // resolved.principal / ctx.agentGroupId. First blocking hook wins.
  for (const hook of preMutationHooks) {
    const result = await hook({ drive, fileId: args.file_id, ctx, resolved: tokenOrError });
    if (!result.ok) return result;
  }

  try {
    const res = await drive.files.update({
      fileId: args.file_id,
      media: {
        mimeType: 'text/markdown',
        body: Readable.from([args.markdown]),
      },
      requestBody: { mimeType: 'application/vnd.google-apps.document' },
    });
    return {
      ok: true,
      fileId: res.data.id || args.file_id,
      bytes: Buffer.byteLength(args.markdown),
      created: false,
    };
  } catch (err) {
    const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
    if (status === 404 && args.create_if_missing) {
      try {
        const create = await drive.files.create({
          requestBody: {
            name: args.name ?? 'Untitled',
            mimeType: 'application/vnd.google-apps.document',
            parents: args.parent_folder_id ? [args.parent_folder_id] : undefined,
          },
          media: {
            mimeType: 'text/markdown',
            body: Readable.from([args.markdown]),
          },
        });
        const newId = create.data.id ?? '';
        if (newId) {
          for (const hook of postCreateHooks) {
            try {
              await hook({ drive, fileId: newId, ctx, resolved: tokenOrError });
            } catch (hookErr) {
              log.warn('drive_doc_write_from_markdown: post-create hook threw', {
                fileId: newId,
                err: String(hookErr),
              });
            }
          }
        }
        return {
          ok: true,
          fileId: newId,
          bytes: Buffer.byteLength(args.markdown),
          created: true,
        };
      } catch (createErr) {
        log.warn('drive_doc_write_from_markdown create fallback failed', {
          fileId: args.file_id,
          err: String(createErr),
        });
        return {
          ok: false,
          error: `Drive create failed for ${args.file_id}: ${(createErr as Error).message}`,
          status: 500,
        };
      }
    }
    log.warn('drive_doc_write_from_markdown failed', { fileId: args.file_id, status, err: String(err) });
    return {
      ok: false,
      error: `Drive update failed for ${args.file_id}: ${(err as Error).message}`,
      status: typeof status === 'number' ? status : 500,
    };
  }
}

/**
 * Add an agent group to a Drive file's NanoClaw owners list. Caller
 * must already be an owner (or be claiming an untagged file via
 * first-touch — same semantics as `driveDocWriteFromMarkdown`'s
 * pre-flight). No-op when target is already in the list.
 *
 * Mode B note: this tool still runs the caller-must-be-owner check
 * because the tag's semantics shouldn't shift between modes. In
 * practice Mode B users rarely call it (Google's sharing UI is the
 * native path); when they do, claim-on-first-touch still works.
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
 *
 * Idempotent: removing an agent group that isn't currently an owner
 * returns `changed: false` without error.
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
 * No permission check — ownership lookup is informational. In Mode A
 * everyone with workspace access can see anything anyway; in Mode B
 * the file wouldn't be readable at all if not permitted.
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
// Built-in hook registrations.
//
// These wire the Phase 13.6 Mode A ownership primitive into the base
// GWS tools. Each hook decides internally whether to fire based on
// `resolved.principal` and `ctx.agentGroupId` — Mode B callers and
// unattributed callers are no-ops.
//
// In Phase R.2 of the trunk → branch refactor these registrations
// move to a separate self-registering module (`gws-ownership-ext.ts`)
// so the classroom skill can install them independently of the base
// GWS tool surface.
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
