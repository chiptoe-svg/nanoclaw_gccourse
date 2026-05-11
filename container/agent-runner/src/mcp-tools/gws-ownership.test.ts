/**
 * Container-side unit tests for the GWS ownership extension tools.
 * Mirrors the shape of gws.test.ts; mocks `globalThis.fetch` so no
 * relay needs to run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { driveDocGrantOwnership, driveDocListOwners, driveDocRevokeOwnership } from './gws-ownership.js';

const RELAY_URL = 'http://host.docker.internal:3007';

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function captureFetch(response: { status: number; body: unknown }): {
  calls: CapturedCall[];
  restore: () => void;
} {
  const calls: CapturedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe('gws-ownership.ts → relay HTTP shape', () => {
  let savedRelay: string | undefined;
  let savedAgent: string | undefined;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    savedRelay = process.env.GWS_MCP_RELAY_URL;
    savedAgent = process.env.X_NANOCLAW_AGENT_GROUP;
    process.env.GWS_MCP_RELAY_URL = RELAY_URL;
    process.env.X_NANOCLAW_AGENT_GROUP = 'ag_test_42';
  });

  afterEach(() => {
    if (restore) restore();
    restore = null;
    if (savedRelay === undefined) delete process.env.GWS_MCP_RELAY_URL;
    else process.env.GWS_MCP_RELAY_URL = savedRelay;
    if (savedAgent === undefined) delete process.env.X_NANOCLAW_AGENT_GROUP;
    else process.env.X_NANOCLAW_AGENT_GROUP = savedAgent;
  });

  test('drive_doc_grant_ownership forwards file_id + agent_group_id', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, fileId: 'f1', owners: ['ag_42', 'ag_77'], changed: true },
    });
    restore = cap.restore;

    const result = await driveDocGrantOwnership.handler({ file_id: 'f1', agent_group_id: 'ag_77' });

    expect(cap.calls[0]!.url).toBe(`${RELAY_URL}/tools/drive_doc_grant_ownership`);
    expect(JSON.parse(cap.calls[0]!.init?.body as string)).toEqual({
      file_id: 'f1',
      agent_group_id: 'ag_77',
    });
    expect(result.isError).toBeUndefined();
  });

  test('drive_doc_revoke_ownership surfaces last-owner refusal with status 409', async () => {
    const cap = captureFetch({
      status: 409,
      body: { ok: false, error: 'Refusing to revoke last owner of f1 — grant ownership first.', status: 409 },
    });
    restore = cap.restore;

    const result = await driveDocRevokeOwnership.handler({ file_id: 'f1', agent_group_id: 'ag_42' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Refusing to revoke last owner');
  });

  test('drive_doc_list_owners returns owners with display names', async () => {
    const cap = captureFetch({
      status: 200,
      body: {
        ok: true,
        fileId: 'f1',
        owners: [
          { agent_group_id: 'ag_42', display_name: 'Sam' },
          { agent_group_id: 'ag_77', display_name: 'Alice' },
        ],
      },
    });
    restore = cap.restore;

    const result = await driveDocListOwners.handler({ file_id: 'f1' });

    expect(cap.calls[0]!.url).toBe(`${RELAY_URL}/tools/drive_doc_list_owners`);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Sam');
    expect(text).toContain('Alice');
  });
});
