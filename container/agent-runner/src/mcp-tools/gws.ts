/**
 * Google Workspace MCP tools (Phase 13).
 *
 * Forwards calls to the host-side relay (`src/gws-mcp-relay.ts`,
 * default port 3007) rather than hitting googleapis.com directly. The
 * relay authenticates the caller via the `X-NanoClaw-Agent-Group`
 * header, applies role-based scoping (`canAccessAgentGroup`), and
 * resolves a per-student OAuth bearer via
 * `getGoogleAccessTokenForAgentGroup`. Everything Google-specific
 * stays on the host.
 *
 * V1 surface (mirrors `src/gws-mcp-server.ts`):
 *   drive_doc_read_as_markdown    — export a Doc to markdown
 *   drive_doc_write_from_markdown — overwrite (or create) a Doc from markdown
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

interface RelayCallResult {
  ok: true;
  body: unknown;
}
interface RelayCallError {
  ok: false;
  error: string;
}

async function callRelay(toolName: string, args: Record<string, unknown>): Promise<RelayCallResult | RelayCallError> {
  const relayUrl = process.env.GWS_MCP_RELAY_URL;
  const agentGroupId = process.env.X_NANOCLAW_AGENT_GROUP;
  if (!relayUrl) {
    return { ok: false, error: 'GWS_MCP_RELAY_URL not set — running outside a NanoClaw container?' };
  }
  if (!agentGroupId) {
    return { ok: false, error: 'X_NANOCLAW_AGENT_GROUP not set — relay would reject the call.' };
  }
  let res: Response;
  try {
    res = await fetch(`${relayUrl}/tools/${toolName}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nanoclaw-agent-group': agentGroupId,
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    return { ok: false, error: `GWS relay unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `GWS relay returned non-JSON (${res.status}): ${e instanceof Error ? e.message : String(e)}` };
  }
  // Relay echoes `{ ok, ... }` for both success and tool-error paths;
  // status code mirrors `ok`. Either signal is sufficient to branch.
  if (body && typeof body === 'object' && (body as { ok?: unknown }).ok === false) {
    const message = (body as { error?: unknown }).error;
    return { ok: false, error: typeof message === 'string' ? message : `GWS relay error (status ${res.status})` };
  }
  if (!res.ok) {
    return { ok: false, error: `GWS relay HTTP ${res.status}` };
  }
  return { ok: true, body };
}

export const driveDocReadAsMarkdown: McpToolDefinition = {
  tool: {
    name: 'drive_doc_read_as_markdown',
    description:
      'Read a Google Doc and return its contents as markdown. Use this when you need to read or analyze the text of a Google Doc — rclone gives you a .gdoc pointer, this gives you the actual content. Pass the Doc file ID (the part after /document/d/ in the URL).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID of the Google Doc.' },
      },
      required: ['file_id'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    if (!fileId) return err('file_id is required');
    const r = await callRelay('drive_doc_read_as_markdown', { file_id: fileId });
    if (!r.ok) return err(r.error);
    const markdown = (r.body as { markdown?: unknown }).markdown;
    if (typeof markdown !== 'string') return err('GWS relay response missing `markdown` field.');
    return ok(markdown);
  },
};

export const driveDocWriteFromMarkdown: McpToolDefinition = {
  tool: {
    name: 'drive_doc_write_from_markdown',
    description:
      'Overwrite an existing Google Doc with new markdown content. Pass `file_id` of the target Doc and the `markdown` body. To create a new Doc when the file_id does not exist yet, set `create_if_missing: true` and provide `parent_folder_id` + `name`. Returns the resulting Doc\'s file ID and whether it was newly created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID of the Google Doc to overwrite (or create at, with create_if_missing).' },
        markdown: { type: 'string', description: 'Markdown body to upload as the Doc\'s new content.' },
        create_if_missing: { type: 'boolean', description: 'When true and the file_id 404s, create a new Doc instead.' },
        parent_folder_id: { type: 'string', description: 'Drive folder ID to place the new Doc in (used only on create).' },
        name: { type: 'string', description: 'Title for the new Doc (used only on create).' },
      },
      required: ['file_id', 'markdown'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    const markdown = args.markdown as string;
    if (!fileId) return err('file_id is required');
    if (typeof markdown !== 'string') return err('markdown is required');
    const payload: Record<string, unknown> = { file_id: fileId, markdown };
    if (typeof args.create_if_missing === 'boolean') payload.create_if_missing = args.create_if_missing;
    if (typeof args.parent_folder_id === 'string') payload.parent_folder_id = args.parent_folder_id;
    if (typeof args.name === 'string') payload.name = args.name;
    const r = await callRelay('drive_doc_write_from_markdown', payload);
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const driveDocGrantOwnership: McpToolDefinition = {
  tool: {
    name: 'drive_doc_grant_ownership',
    description:
      'Add another NanoClaw agent group as a co-owner of a Google Doc/Sheet/Slides file. Caller must already be an owner. Use this when you want another agent (e.g., a teammate\'s agent) to be able to edit a file you created. Returns the new owners list. In Mode A (shared class workspace) this is the friction layer that gates writes; in Mode B (per-person Google accounts) it\'s informational.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID to grant ownership on.' },
        agent_group_id: { type: 'string', description: 'NanoClaw agent group ID to add as co-owner.' },
      },
      required: ['file_id', 'agent_group_id'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    const agentGroupId = args.agent_group_id as string;
    if (!fileId) return err('file_id is required');
    if (!agentGroupId) return err('agent_group_id is required');
    const r = await callRelay('drive_doc_grant_ownership', { file_id: fileId, agent_group_id: agentGroupId });
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const driveDocRevokeOwnership: McpToolDefinition = {
  tool: {
    name: 'drive_doc_revoke_ownership',
    description:
      'Remove an agent group from a Google Doc/Sheet/Slides file\'s owners list. Caller must be an owner. Refuses to remove the last owner (would leave the file unowned and claim-able by anyone). Idempotent if the target isn\'t currently an owner.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID to revoke ownership on.' },
        agent_group_id: { type: 'string', description: 'NanoClaw agent group ID to remove from owners.' },
      },
      required: ['file_id', 'agent_group_id'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    const agentGroupId = args.agent_group_id as string;
    if (!fileId) return err('file_id is required');
    if (!agentGroupId) return err('agent_group_id is required');
    const r = await callRelay('drive_doc_revoke_ownership', { file_id: fileId, agent_group_id: agentGroupId });
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

export const driveDocListOwners: McpToolDefinition = {
  tool: {
    name: 'drive_doc_list_owners',
    description:
      'List the NanoClaw agent groups that "own" a Google Doc/Sheet/Slides file (i.e., are permitted to write to it through NanoClaw tools). Returns each owner\'s agent group ID and display name. Useful before attempting a write that might be blocked.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: 'Drive file ID to list owners of.' },
      },
      required: ['file_id'],
    },
  },
  async handler(args) {
    const fileId = args.file_id as string;
    if (!fileId) return err('file_id is required');
    const r = await callRelay('drive_doc_list_owners', { file_id: fileId });
    if (!r.ok) return err(r.error);
    return ok(JSON.stringify(r.body, null, 2));
  },
};

registerTools([
  driveDocReadAsMarkdown,
  driveDocWriteFromMarkdown,
  driveDocGrantOwnership,
  driveDocRevokeOwnership,
  driveDocListOwners,
]);
