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

import { getGoogleAccessTokenForAgentGroup } from './gws-token.js';
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

function buildDriveClient(accessToken: string): ReturnType<typeof driveApi> {
  const oauth = new gAuth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return driveApi({ version: 'v3', auth: oauth });
}

async function resolveTokenOrError(ctx: ToolContext): Promise<string | ToolError> {
  const token = await getGoogleAccessTokenForAgentGroup(ctx.agentGroupId);
  if (!token) {
    return {
      ok: false,
      error:
        'No Google OAuth token available — instructor needs ~/.config/gws/credentials.json or the student needs to complete /add-classroom-auth.',
      status: 502,
    };
  }
  return token;
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
  if (typeof tokenOrError !== 'string') return tokenOrError;
  const drive = buildDriveClient(tokenOrError);

  try {
    const res = await drive.files.export(
      { fileId: args.file_id, mimeType: 'text/markdown' },
      { responseType: 'text' },
    );
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
  if (typeof tokenOrError !== 'string') return tokenOrError;
  const drive = buildDriveClient(tokenOrError);

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
        return {
          ok: true,
          fileId: create.data.id ?? '',
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
