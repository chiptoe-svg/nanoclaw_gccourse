/**
 * GWS MCP server — tool registry + dispatch.
 *
 * In-process function callable by `gws-mcp-relay.ts` after the relay
 * has read the per-call attribution header and confirmed the agent
 * group exists. Knows nothing about HTTP — pure dispatch.
 *
 * V1 surface (Phase 13.2):
 *   - `drive_doc_read_as_markdown`
 *   - `drive_doc_write_from_markdown`
 *
 * Adding a tool: define the handler in `gws-mcp-tools.ts`, add an
 * entry to `TOOL_REGISTRY` below. Argument validation is the tool
 * handler's responsibility (returns `ToolError` with status 400 on
 * malformed input).
 */
import {
  driveDocReadAsMarkdown,
  driveDocWriteFromMarkdown,
  driveGrantOwnership,
  driveListOwners,
  driveRevokeOwnership,
  type ToolContext,
  type ToolError,
  type DocReadResult,
  type DocWriteResult,
  type ListOwnersResult,
  type OwnershipChangeResult,
} from './gws-mcp-tools.js';

export type ToolName =
  | 'drive_doc_read_as_markdown'
  | 'drive_doc_write_from_markdown'
  | 'drive_doc_grant_ownership'
  | 'drive_doc_revoke_ownership'
  | 'drive_doc_list_owners';

export type ToolResult = (DocReadResult | DocWriteResult | OwnershipChangeResult | ListOwnersResult | ToolError) & {
  ok: boolean;
};

interface ToolEntry<A> {
  name: ToolName;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: ToolContext, args: any) => Promise<ToolResult>;
  validate: (raw: unknown) => A | string;
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function asString(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function validateRead(raw: unknown): { file_id: string } | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const fileId = asString(o, 'file_id');
  if (!fileId) return '`file_id` (string) is required';
  return { file_id: fileId };
}

function validateWrite(
  raw: unknown,
):
  | { file_id: string; markdown: string; create_if_missing?: boolean; parent_folder_id?: string; name?: string }
  | string {
  const o = asObject(raw);
  if (!o) return 'arguments must be an object';
  const fileId = asString(o, 'file_id');
  if (!fileId) return '`file_id` (string) is required';
  const markdown = typeof o.markdown === 'string' ? o.markdown : null;
  if (markdown === null) return '`markdown` (string) is required';
  return {
    file_id: fileId,
    markdown,
    create_if_missing: typeof o.create_if_missing === 'boolean' ? o.create_if_missing : undefined,
    parent_folder_id: asString(o, 'parent_folder_id') ?? undefined,
    name: asString(o, 'name') ?? undefined,
  };
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

// Mutable registry — populated below by built-in registerGwsTool calls,
// and extensible at module-load time by extensions
// (e.g., classroom-gws's ownership module in Phase R.2+).
const TOOL_REGISTRY: Partial<Record<string, ToolEntry<unknown>>> = {};

/**
 * Register a GWS tool into the in-process registry. Called at module
 * load — built-in V1 tools register themselves below; extensions
 * (installed by skills like /add-classroom-gws) self-register via
 * the same call.
 *
 * Last-registration-wins for a given name; this lets an extension
 * override a base tool's behavior if needed (rare).
 */
export function registerGwsTool(name: string, entry: { handler: ToolEntry<unknown>['handler']; validate: ToolEntry<unknown>['validate'] }): void {
  TOOL_REGISTRY[name] = { name: name as ToolName, handler: entry.handler, validate: entry.validate };
}

registerGwsTool('drive_doc_read_as_markdown', {
  handler: driveDocReadAsMarkdown,
  validate: validateRead as (raw: unknown) => unknown | string,
});
registerGwsTool('drive_doc_write_from_markdown', {
  handler: driveDocWriteFromMarkdown,
  validate: validateWrite as (raw: unknown) => unknown | string,
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

/** Names of every registered tool — used by the relay's introspection
 * endpoint and by tests. */
export function listToolNames(): ToolName[] {
  return Object.keys(TOOL_REGISTRY) as ToolName[];
}

/**
 * Dispatch a tool call. Validates args first; on failure returns a
 * `ToolError` with status 400. Unknown tool name returns 404. Any
 * unhandled exception inside the tool becomes a 500. Otherwise returns
 * whatever the tool returned.
 */
export async function dispatchTool(opts: { ctx: ToolContext; toolName: string; args: unknown }): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[opts.toolName];
  if (!entry) {
    return { ok: false, error: `Unknown tool: ${opts.toolName}`, status: 404 };
  }
  const validatedOrError = entry.validate(opts.args);
  if (typeof validatedOrError === 'string') {
    return { ok: false, error: `Invalid arguments: ${validatedOrError}`, status: 400 };
  }
  try {
    return await entry.handler(opts.ctx, validatedOrError);
  } catch (err) {
    return { ok: false, error: `Tool ${opts.toolName} threw: ${(err as Error).message}`, status: 500 };
  }
}
