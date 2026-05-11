/**
 * Container-side shims for the GWS ownership extension tools.
 *
 * Three tools that mirror the host-side `gws-ownership-ext.ts`
 * registrations:
 *   - drive_doc_grant_ownership
 *   - drive_doc_revoke_ownership
 *   - drive_doc_list_owners
 *
 * Each forwards to the relay using the shared callRelay helper from
 * `gws.ts`. Lives in a separate file (from `gws.ts`) so the classroom
 * install skill can copy this in without overwriting the base GWS
 * tools — matching the small-trunk-with-skills philosophy.
 */
import { callRelay } from './gws.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }], isError: true };
}

export const driveDocGrantOwnership: McpToolDefinition = {
  tool: {
    name: 'drive_doc_grant_ownership',
    description:
      "Add another NanoClaw agent group as a co-owner of a Google Doc/Sheet/Slides file. Caller must already be an owner. Use this when you want another agent (e.g., a teammate's agent) to be able to edit a file you created. Returns the new owners list. In Mode A (shared class workspace) this is the friction layer that gates writes; in Mode B (per-person Google accounts) it's informational.",
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
      "Remove an agent group from a Google Doc/Sheet/Slides file's owners list. Caller must be an owner. Refuses to remove the last owner (would leave the file unowned and claim-able by anyone). Idempotent if the target isn't currently an owner.",
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

registerTools([driveDocGrantOwnership, driveDocRevokeOwnership, driveDocListOwners]);
