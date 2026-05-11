/**
 * Tests for the GWS ownership extension module.
 *
 * The ext module self-registers hooks + the three grant/revoke/list
 * tools at import time. We mock the deep dependencies (`gws-ownership`
 * helpers + `gws-mcp-tools` for token resolution and drive client) so
 * tests don't reach Drive.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) => {
    if (id === 'ag_owner') return { id, name: 'Owner', folder: 'o', agent_provider: null, model: null, created_at: '' };
    if (id === 'ag_friend') return { id, name: 'Friend', folder: 'f', agent_provider: null, model: null, created_at: '' };
    return undefined;
  }),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('./gws-mcp-tools.js', () => ({
  buildDriveClient: vi.fn(() => ({ /* stand-in drive client */ })),
  resolveTokenOrError: vi.fn(async () => ({ token: 'tok', principal: 'instructor-fallback' as const })),
  registerPreMutationHook: vi.fn(),
  registerPostCreateHook: vi.fn(),
}));

// Mock gws-mcp-server's registerGwsTool so we can inspect what got registered.
// vi.mock factories are hoisted above all top-level code, so the shared registry
// object must also be hoisted (otherwise it's undefined when the factory runs).
const { registeredTools } = vi.hoisted(() => ({
  registeredTools: {} as Record<string, { handler: unknown; validate: unknown }>,
}));
vi.mock('./gws-mcp-server.js', () => ({
  registerGwsTool: vi.fn((name: string, entry: { handler: unknown; validate: unknown }) => {
    registeredTools[name] = entry;
  }),
}));

// Mock the ownership helpers so we control read/write results.
vi.mock('./gws-ownership.js', () => ({
  claimOrCheckDriveOwnership: vi.fn(),
  formatHardBlockMessage: vi.fn((fileId: string, owners: string[]) => `BLOCKED ${fileId} by ${owners.join(',')}`),
  readDriveOwners: vi.fn(),
  stampNewDriveFile: vi.fn(),
  writeDriveOwners: vi.fn(),
}));

// Importing the ext triggers self-registration into `registeredTools`.
import './gws-ownership-ext.js';
import { claimOrCheckDriveOwnership, readDriveOwners, writeDriveOwners } from './gws-ownership.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('gws-ownership-ext self-registration', () => {
  it('registers the three ownership tools at import time', () => {
    expect(Object.keys(registeredTools).sort()).toEqual([
      'drive_doc_grant_ownership',
      'drive_doc_list_owners',
      'drive_doc_revoke_ownership',
    ]);
  });
});

describe('drive_doc_grant_ownership', () => {
  it('adds the target agent_group_id to the owners list', async () => {
    (claimOrCheckDriveOwnership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      owners: ['ag_owner'],
      claimed: false,
    });
    const handler = registeredTools['drive_doc_grant_ownership']!.handler as (
      ctx: { agentGroupId: string | null },
      args: { file_id: string; agent_group_id: string },
    ) => Promise<unknown>;
    const r = (await handler(
      { agentGroupId: 'ag_owner' },
      { file_id: 'f1', agent_group_id: 'ag_friend' },
    )) as { ok: boolean; owners: string[]; changed: boolean };

    expect(r.ok).toBe(true);
    expect(r.owners).toEqual(['ag_owner', 'ag_friend']);
    expect(r.changed).toBe(true);
    expect(writeDriveOwners).toHaveBeenCalledWith(expect.anything(), 'f1', ['ag_owner', 'ag_friend']);
  });

  it('is a no-op when target is already an owner', async () => {
    (claimOrCheckDriveOwnership as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      owners: ['ag_owner', 'ag_friend'],
      claimed: false,
    });
    const handler = registeredTools['drive_doc_grant_ownership']!.handler as (
      ctx: { agentGroupId: string | null },
      args: { file_id: string; agent_group_id: string },
    ) => Promise<unknown>;
    const r = (await handler(
      { agentGroupId: 'ag_owner' },
      { file_id: 'f1', agent_group_id: 'ag_friend' },
    )) as { ok: boolean; changed: boolean };

    expect(r.ok).toBe(true);
    expect(r.changed).toBe(false);
    expect(writeDriveOwners).not.toHaveBeenCalled();
  });

  it('requires an attributed caller (returns 400)', async () => {
    const handler = registeredTools['drive_doc_grant_ownership']!.handler as (
      ctx: { agentGroupId: string | null },
      args: unknown,
    ) => Promise<unknown>;
    const r = (await handler({ agentGroupId: null }, { file_id: 'f1', agent_group_id: 'ag_friend' })) as {
      ok: boolean;
      status: number;
    };
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});

describe('drive_doc_revoke_ownership', () => {
  it('refuses to revoke the last owner (409)', async () => {
    (readDriveOwners as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['ag_owner']);
    const handler = registeredTools['drive_doc_revoke_ownership']!.handler as (
      ctx: { agentGroupId: string | null },
      args: { file_id: string; agent_group_id: string },
    ) => Promise<unknown>;
    const r = (await handler(
      { agentGroupId: 'ag_owner' },
      { file_id: 'f1', agent_group_id: 'ag_owner' },
    )) as { ok: boolean; status: number; error: string };
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toContain('last owner');
  });

  it('removes the target and writes the new list', async () => {
    (readDriveOwners as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['ag_owner', 'ag_friend']);
    const handler = registeredTools['drive_doc_revoke_ownership']!.handler as (
      ctx: { agentGroupId: string | null },
      args: { file_id: string; agent_group_id: string },
    ) => Promise<unknown>;
    const r = (await handler(
      { agentGroupId: 'ag_owner' },
      { file_id: 'f1', agent_group_id: 'ag_friend' },
    )) as { ok: boolean; owners: string[]; changed: boolean };
    expect(r.ok).toBe(true);
    expect(r.owners).toEqual(['ag_owner']);
    expect(r.changed).toBe(true);
    expect(writeDriveOwners).toHaveBeenCalledWith(expect.anything(), 'f1', ['ag_owner']);
  });

  it('hard-blocks when caller is not currently an owner (403)', async () => {
    (readDriveOwners as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['ag_owner']);
    const handler = registeredTools['drive_doc_revoke_ownership']!.handler as (
      ctx: { agentGroupId: string | null },
      args: { file_id: string; agent_group_id: string },
    ) => Promise<unknown>;
    const r = (await handler(
      { agentGroupId: 'ag_stranger' },
      { file_id: 'f1', agent_group_id: 'ag_owner' },
    )) as { ok: boolean; status: number };
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe('drive_doc_list_owners', () => {
  it('returns owners with display names resolved', async () => {
    (readDriveOwners as ReturnType<typeof vi.fn>).mockResolvedValueOnce(['ag_owner', 'ag_friend', 'ag_ghost']);
    const handler = registeredTools['drive_doc_list_owners']!.handler as (
      ctx: { agentGroupId: string | null },
      args: { file_id: string },
    ) => Promise<unknown>;
    const r = (await handler({ agentGroupId: 'ag_owner' }, { file_id: 'f1' })) as {
      ok: boolean;
      owners: Array<{ agent_group_id: string; display_name: string | null }>;
    };
    expect(r.ok).toBe(true);
    expect(r.owners).toEqual([
      { agent_group_id: 'ag_owner', display_name: 'Owner' },
      { agent_group_id: 'ag_friend', display_name: 'Friend' },
      { agent_group_id: 'ag_ghost', display_name: null },
    ]);
  });
});
