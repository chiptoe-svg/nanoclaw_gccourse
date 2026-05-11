/**
 * Unit tests for the Mode A ownership tagging helpers.
 *
 * We mock the @googleapis/drive client so the tests don't hit
 * Google and can drive the read/write paths precisely. The
 * agent_groups DB lookup is mocked so display names resolve
 * predictably in the hard-block message.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { getAgentGroup } from './db/agent-groups.js';
import {
  OWNERS_PROPERTY,
  readDriveOwners,
  writeDriveOwners,
  formatHardBlockMessage,
  claimOrCheckDriveOwnership,
  stampNewDriveFile,
} from './gws-ownership.js';

// Minimal shape of the Drive client our helpers touch.
function mockDrive(opts?: {
  getResponse?: { data: { properties?: Record<string, string> } };
  getThrows?: unknown;
  updateThrows?: unknown;
  permissionsCreateThrows?: unknown;
}): {
  client: Parameters<typeof readDriveOwners>[0];
  calls: { get: unknown[][]; update: unknown[][]; permissions: unknown[][] };
} {
  const calls = { get: [] as unknown[][], update: [] as unknown[][], permissions: [] as unknown[][] };
  const client = {
    files: {
      get: vi.fn(async (...args: unknown[]) => {
        calls.get.push(args);
        if (opts?.getThrows) throw opts.getThrows;
        return opts?.getResponse ?? { data: {} };
      }),
      update: vi.fn(async (...args: unknown[]) => {
        calls.update.push(args);
        if (opts?.updateThrows) throw opts.updateThrows;
        return { data: {} };
      }),
    },
    permissions: {
      create: vi.fn(async (...args: unknown[]) => {
        calls.permissions.push(args);
        if (opts?.permissionsCreateThrows) throw opts.permissionsCreateThrows;
        return { data: {} };
      }),
    },
  } as unknown as Parameters<typeof readDriveOwners>[0];
  return { client, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readDriveOwners', () => {
  it('returns empty array when properties is missing', async () => {
    const { client } = mockDrive({ getResponse: { data: {} } });
    const owners = await readDriveOwners(client, 'fileA');
    expect(owners).toEqual([]);
  });

  it('returns empty array when nanoclaw_owners key is absent', async () => {
    const { client } = mockDrive({ getResponse: { data: { properties: { other: 'x' } } } });
    expect(await readDriveOwners(client, 'fileA')).toEqual([]);
  });

  it('parses comma-separated owners and trims whitespace', async () => {
    const { client } = mockDrive({
      getResponse: { data: { properties: { [OWNERS_PROPERTY]: 'ag_1, ag_2 ,ag_3' } } },
    });
    expect(await readDriveOwners(client, 'fileA')).toEqual(['ag_1', 'ag_2', 'ag_3']);
  });

  it('filters out empty entries', async () => {
    const { client } = mockDrive({
      getResponse: { data: { properties: { [OWNERS_PROPERTY]: 'ag_1,,ag_2,' } } },
    });
    expect(await readDriveOwners(client, 'fileA')).toEqual(['ag_1', 'ag_2']);
  });
});

describe('writeDriveOwners', () => {
  it('writes comma-joined owners to the properties field', async () => {
    const { client, calls } = mockDrive();
    await writeDriveOwners(client, 'fileA', ['ag_1', 'ag_2']);
    expect(calls.update[0]![0]).toMatchObject({
      fileId: 'fileA',
      requestBody: { properties: { [OWNERS_PROPERTY]: 'ag_1,ag_2' } },
    });
  });

  it('throws when owners list is empty (leaves no owner)', async () => {
    const { client } = mockDrive();
    await expect(writeDriveOwners(client, 'fileA', [])).rejects.toThrow(/cannot be empty/);
  });
});

describe('formatHardBlockMessage', () => {
  it('resolves agent-group names and lists them with "and"', () => {
    (getAgentGroup as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === 'ag_1') return { id: 'ag_1', name: 'Sam', folder: 's', agent_provider: null, model: null, created_at: '' };
      if (id === 'ag_2') return { id: 'ag_2', name: 'Alice', folder: 'a', agent_provider: null, model: null, created_at: '' };
      return undefined;
    });
    const msg = formatHardBlockMessage('fileA', ['ag_1', 'ag_2']);
    expect(msg).toContain('Sam and Alice');
    expect(msg).toContain('drive_doc_grant_ownership');
  });

  it('falls back to id (unknown) for missing agent groups', () => {
    (getAgentGroup as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const msg = formatHardBlockMessage('fileA', ['ag_ghost']);
    expect(msg).toContain('ag_ghost (unknown)');
  });
});

describe('claimOrCheckDriveOwnership', () => {
  it('claims an untagged file for the caller', async () => {
    const { client, calls } = mockDrive({ getResponse: { data: {} } });
    const r = await claimOrCheckDriveOwnership(client, 'fileA', 'ag_42');
    expect(r.ok).toBe(true);
    expect((r as { claimed: boolean }).claimed).toBe(true);
    expect((r as { owners: string[] }).owners).toEqual(['ag_42']);
    // Should have called update with the new owner tag.
    expect(calls.update[0]![0]).toMatchObject({
      fileId: 'fileA',
      requestBody: { properties: { [OWNERS_PROPERTY]: 'ag_42' } },
    });
  });

  it('clears when caller is already in the owners list', async () => {
    const { client, calls } = mockDrive({
      getResponse: { data: { properties: { [OWNERS_PROPERTY]: 'ag_1,ag_42' } } },
    });
    const r = await claimOrCheckDriveOwnership(client, 'fileA', 'ag_42');
    expect(r.ok).toBe(true);
    expect((r as { claimed: boolean }).claimed).toBe(false);
    expect(calls.update).toHaveLength(0);
  });

  it('hard-blocks when caller is not in the owners list', async () => {
    (getAgentGroup as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'ag_1',
      name: 'Sam',
      folder: 's',
      agent_provider: null,
      model: null,
      created_at: '',
    });
    const { client } = mockDrive({
      getResponse: { data: { properties: { [OWNERS_PROPERTY]: 'ag_1' } } },
    });
    const r = await claimOrCheckDriveOwnership(client, 'fileA', 'ag_42');
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(403);
    expect((r as { error: string }).error).toContain('Sam');
  });

  it('treats read failures as untagged + skips claim', async () => {
    const { client, calls } = mockDrive({ getThrows: new Error('not found') });
    const r = await claimOrCheckDriveOwnership(client, 'fileA', 'ag_42');
    expect(r.ok).toBe(true);
    expect((r as { claimed: boolean }).claimed).toBe(false);
    expect(calls.update).toHaveLength(0);
  });
});

describe('stampNewDriveFile', () => {
  it('writes owner tag and applies anyone-with-link writer share', async () => {
    const { client, calls } = mockDrive();
    await stampNewDriveFile(client, 'fileA', 'ag_42');
    expect(calls.update[0]![0]).toMatchObject({
      fileId: 'fileA',
      requestBody: { properties: { [OWNERS_PROPERTY]: 'ag_42' } },
    });
    expect(calls.permissions[0]![0]).toMatchObject({
      fileId: 'fileA',
      requestBody: { type: 'anyone', role: 'writer' },
    });
  });

  it('swallows tag-write failures (best effort)', async () => {
    const { client } = mockDrive({ updateThrows: new Error('boom') });
    await expect(stampNewDriveFile(client, 'fileA', 'ag_42')).resolves.toBeUndefined();
  });

  it('swallows share failures (best effort)', async () => {
    const { client } = mockDrive({ permissionsCreateThrows: new Error('forbidden') });
    await expect(stampNewDriveFile(client, 'fileA', 'ag_42')).resolves.toBeUndefined();
  });
});
