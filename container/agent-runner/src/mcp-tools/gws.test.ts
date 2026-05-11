/**
 * Unit tests for the container-side Google Workspace MCP tools.
 * Verifies the tool handlers translate args → relay HTTP POST, and the
 * relay's `{ ok, ... }` envelope into MCP `content` / `isError` shape.
 *
 * Bun runtime — `bun:test`. We mock `globalThis.fetch` directly so the
 * tests don't need a running relay.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { driveDocReadAsMarkdown, driveDocWriteFromMarkdown } from './gws.js';

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

describe('gws.ts → relay HTTP shape', () => {
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

  test('drive_doc_read_as_markdown POSTs to the right path with attribution header', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, fileId: 'f1', markdown: '# Hi', bytes: 4 },
    });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'f1' });

    expect(cap.calls).toHaveLength(1);
    const call = cap.calls[0]!;
    expect(call.url).toBe(`${RELAY_URL}/tools/drive_doc_read_as_markdown`);
    expect(call.init?.method).toBe('POST');
    const headers = new Headers(call.init?.headers as HeadersInit | undefined);
    expect(headers.get('x-nanoclaw-agent-group')).toBe('ag_test_42');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call.init?.body as string)).toEqual({ file_id: 'f1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: '# Hi' });
  });

  test('drive_doc_read_as_markdown surfaces relay error body as MCP isError', async () => {
    const cap = captureFetch({
      status: 404,
      body: { ok: false, error: 'File not found', status: 404 },
    });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'gone' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('File not found');
  });

  test('drive_doc_write_from_markdown forwards optional create flags', async () => {
    const cap = captureFetch({
      status: 200,
      body: { ok: true, fileId: 'f2', bytes: 5, created: true },
    });
    restore = cap.restore;

    const result = await driveDocWriteFromMarkdown.handler({
      file_id: 'f2',
      markdown: 'hello',
      create_if_missing: true,
      parent_folder_id: 'folder_xyz',
      name: 'My Doc',
    });

    const body = JSON.parse(cap.calls[0]!.init?.body as string);
    expect(body).toEqual({
      file_id: 'f2',
      markdown: 'hello',
      create_if_missing: true,
      parent_folder_id: 'folder_xyz',
      name: 'My Doc',
    });
    expect(result.isError).toBeUndefined();
  });

  test('returns MCP error when GWS_MCP_RELAY_URL unset (no fetch call)', async () => {
    delete process.env.GWS_MCP_RELAY_URL;
    const cap = captureFetch({ status: 200, body: { ok: true } });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'whatever' });

    expect(cap.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  test('returns MCP error when X_NANOCLAW_AGENT_GROUP unset (no fetch call)', async () => {
    delete process.env.X_NANOCLAW_AGENT_GROUP;
    const cap = captureFetch({ status: 200, body: { ok: true } });
    restore = cap.restore;

    const result = await driveDocReadAsMarkdown.handler({ file_id: 'whatever' });

    expect(cap.calls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  test('hard-block error from drive_doc_write_from_markdown surfaces creator name', async () => {
    const cap = captureFetch({
      status: 403,
      body: {
        ok: false,
        error:
          'Blocked: this file is owned by Sam. Ask one of them to share write access via drive_doc_grant_ownership, or to make the change themselves.',
        status: 403,
      },
    });
    restore = cap.restore;

    const result = await driveDocWriteFromMarkdown.handler({ file_id: 'f1', markdown: '# nope' });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Sam');
    expect(text).toContain('drive_doc_grant_ownership');
  });

});
