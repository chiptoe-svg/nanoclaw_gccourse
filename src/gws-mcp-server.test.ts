/**
 * Server / dispatch unit tests. Stubs the tool handlers so this suite
 * never hits @googleapis. Validation paths covered here; the actual
 * Drive API interaction lives in gws-mcp-tools.test.ts (mocked there).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./gws-mcp-tools.js', () => ({
  driveDocReadAsMarkdown: vi.fn(async (_ctx, args: { file_id: string }) => ({
    ok: true,
    fileId: args.file_id,
    markdown: '# stub\n',
    bytes: 8,
  })),
  driveDocWriteFromMarkdown: vi.fn(async (_ctx, args: { file_id: string }) => ({
    ok: true,
    fileId: args.file_id,
    bytes: 0,
    created: false,
  })),
}));

import { dispatchTool, listToolNames } from './gws-mcp-server.js';

afterEach(() => vi.clearAllMocks());

describe('listToolNames', () => {
  it('returns the V1 tool names', () => {
    expect(new Set(listToolNames())).toEqual(
      new Set(['drive_doc_read_as_markdown', 'drive_doc_write_from_markdown']),
    );
  });
});

describe('dispatchTool', () => {
  it('returns 404 for unknown tool', async () => {
    const r = await dispatchTool({ ctx: { agentGroupId: 'ag_x' }, toolName: 'bogus', args: {} });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(404);
  });

  it('returns 400 when args are not an object', async () => {
    const r = await dispatchTool({ ctx: { agentGroupId: 'ag_x' }, toolName: 'drive_doc_read_as_markdown', args: 'oops' });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(400);
  });

  it('returns 400 when read is missing file_id', async () => {
    const r = await dispatchTool({ ctx: { agentGroupId: 'ag_x' }, toolName: 'drive_doc_read_as_markdown', args: {} });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(400);
    expect((r as { error: string }).error).toContain('file_id');
  });

  it('returns 400 when write is missing markdown', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_write_from_markdown',
      args: { file_id: 'abc' },
    });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(400);
    expect((r as { error: string }).error).toContain('markdown');
  });

  it('dispatches to the read handler with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_read_as_markdown',
      args: { file_id: 'doc_abc' },
    });
    expect(r.ok).toBe(true);
    expect((r as { fileId: string }).fileId).toBe('doc_abc');
  });

  it('dispatches to the write handler with validated args', async () => {
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_write_from_markdown',
      args: { file_id: 'doc_abc', markdown: '# hi' },
    });
    expect(r.ok).toBe(true);
  });

  it('catches handler exceptions and returns 500', async () => {
    const tools = await import('./gws-mcp-tools.js');
    (tools.driveDocReadAsMarkdown as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const r = await dispatchTool({
      ctx: { agentGroupId: 'ag_x' },
      toolName: 'drive_doc_read_as_markdown',
      args: { file_id: 'doc_abc' },
    });
    expect(r.ok).toBe(false);
    expect((r as { status?: number }).status).toBe(500);
    expect((r as { error: string }).error).toContain('boom');
  });
});
