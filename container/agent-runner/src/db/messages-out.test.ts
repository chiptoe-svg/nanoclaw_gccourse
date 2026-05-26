import { beforeEach, describe, expect, it } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import { backfillUsage, writeMessageOut } from './messages-out.js';

beforeEach(() => {
  initTestSessionDb();
});

describe('writeMessageOut — cost fields', () => {
  it('persists tokens_in, tokens_out, latency_ms, provider, model on agent-reply rows', () => {
    writeMessageOut({
      id: 'msg-test-1',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
      tokens_in: 1234,
      tokens_out: 567,
      latency_ms: 4200,
      provider: 'claude',
      model: 'claude-sonnet-4-5',
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, latency_ms, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-1') as {
      tokens_in: number | null;
      tokens_out: number | null;
      latency_ms: number | null;
      provider: string | null;
      model: string | null;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.tokens_in).toBe(1234);
    expect(row!.tokens_out).toBe(567);
    expect(row!.latency_ms).toBe(4200);
    expect(row!.provider).toBe('claude');
    expect(row!.model).toBe('claude-sonnet-4-5');
  });

  it('leaves cost fields null when not provided (non-agent-reply rows)', () => {
    writeMessageOut({
      id: 'msg-test-2',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'error message' }),
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, latency_ms, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-2') as {
      tokens_in: number | null;
      tokens_out: number | null;
      latency_ms: number | null;
      provider: string | null;
      model: string | null;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.tokens_in).toBeNull();
    expect(row!.tokens_out).toBeNull();
    expect(row!.latency_ms).toBeNull();
    expect(row!.provider).toBeNull();
    expect(row!.model).toBeNull();
  });
});

describe('backfillUsage', () => {
  it('populates NULL usage fields on matching in_reply_to rows', () => {
    // Write a mid-turn row (send_message style) — no usage yet
    writeMessageOut({
      id: 'msg-test-bf-1',
      in_reply_to: 'inbound-msg-x',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'hello' }),
    });

    const before = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-1') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    expect(before).toBeDefined();
    expect(before!.tokens_in).toBeNull();

    backfillUsage('inbound-msg-x', {
      tokens_in: 100,
      tokens_out: 50,
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
    });

    const after = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-1') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    expect(after!.tokens_in).toBe(100);
    expect(after!.tokens_out).toBe(50);
    expect(after!.provider).toBe('openai-codex');
    expect(after!.model).toBe('gpt-5.4-mini');
  });

  it('does not overwrite rows that already have tokens_in populated', () => {
    // Pre-populated row (e.g. written by dispatchResultText with usage already known)
    writeMessageOut({
      id: 'msg-test-bf-2',
      in_reply_to: 'inbound-msg-y',
      kind: 'chat',
      platform_id: 'test-platform',
      channel_type: 'telegram',
      content: JSON.stringify({ text: 'direct reply' }),
      tokens_in: 999,
      tokens_out: 88,
      provider: 'claude',
      model: 'claude-sonnet-4-5',
    });

    backfillUsage('inbound-msg-y', {
      tokens_in: 1,
      tokens_out: 1,
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
    });

    const row = getOutboundDb()
      .prepare('SELECT tokens_in, tokens_out, provider, model FROM messages_out WHERE id = ?')
      .get('msg-test-bf-2') as { tokens_in: number | null; tokens_out: number | null; provider: string | null; model: string | null } | undefined;
    // Pre-populated values must be preserved
    expect(row!.tokens_in).toBe(999);
    expect(row!.tokens_out).toBe(88);
    expect(row!.provider).toBe('claude');
    expect(row!.model).toBe('claude-sonnet-4-5');
  });
});
