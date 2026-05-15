/**
 * Direct chat — calls the upstream LLM API directly via the credential
 * proxy, no agent infrastructure. The Chat tab's "Chat (no agent)" mode
 * uses this so students can see raw model behavior without agent
 * scaffolding (system prompts, skills, MCP tools, etc.).
 *
 * Today supports the OpenAI Chat Completions wire format. /openai/*
 * goes to api.openai.com; /omlx/* hits the local mlx-omni-server. Claude
 * support can be added by branching on provider and translating to the
 * Anthropic /v1/messages format — not wired today since the class is
 * OpenAI-only.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CREDENTIAL_PROXY_PORT } from '../../../config.js';
import { getAgentGroupByFolder } from '../../../db/agent-groups.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';
import { sessionsBaseDir } from '../../../session-manager.js';
import type { ApiResult } from './me.js';

export interface DirectChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DirectChatResponse {
  text: string;
  tokensIn: number;
  tokensCached: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

function priceFor(entry: ModelEntry | undefined, tokensIn: number, tokensOut: number, tokensCached: number): number {
  if (!entry) return 0;
  if (entry.costPer1kInUsd != null || entry.costPer1kOutUsd != null) {
    const billedIn = Math.max(0, tokensIn - tokensCached);
    return (
      (billedIn / 1000) * (entry.costPer1kInUsd ?? 0) +
      (tokensCached / 1000) * (entry.costPer1kCachedInUsd ?? 0) +
      (tokensOut / 1000) * (entry.costPer1kOutUsd ?? 0)
    );
  }
  const blend = entry.costPer1kTokensUsd ?? 0;
  return ((tokensIn + tokensOut) / 1000) * blend;
}

/**
 * Append a row to the agent's outbound.db so /api/usage/:folder counts
 * direct-chat traffic alongside agent-mediated traffic. We use a pseudo
 * "direct-chat" session directory per agent_group so the data doesn't
 * collide with real session DBs. Missing dir / write failure is logged
 * but non-fatal (the user still got their reply).
 */
function recordDirectChatUsage(
  agentGroupId: string,
  provider: string,
  model: string,
  text: string,
  tokensIn: number,
  tokensOut: number,
): void {
  const sessionDir = path.join(sessionsBaseDir(), agentGroupId, 'direct-chat');
  const outboundPath = path.join(sessionDir, 'outbound.db');
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    const db = new Database(outboundPath);
    db.exec(`CREATE TABLE IF NOT EXISTS messages_out (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp TEXT NOT NULL,
      deliver_after TEXT,
      recurrence TEXT,
      kind TEXT NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      latency_ms INTEGER,
      provider TEXT,
      model TEXT
    )`);
    const id = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, content, tokens_in, tokens_out, provider, model)
       VALUES (?, datetime('now'), 'direct-chat', ?, ?, ?, ?, ?)`,
    ).run(id, JSON.stringify({ text }), tokensIn, tokensOut, provider, model);
    db.close();
  } catch (err) {
    console.error('[direct-chat] usage record failed:', err);
  }
}

export async function handleDirectChat(body: {
  provider?: unknown;
  model?: unknown;
  messages?: unknown;
  agentFolder?: unknown;
}): Promise<ApiResult<DirectChatResponse>> {
  const provider = typeof body.provider === 'string' ? body.provider : '';
  const model = typeof body.model === 'string' ? body.model : '';
  const messages = Array.isArray(body.messages) ? (body.messages as DirectChatMessage[]) : [];
  const agentFolder = typeof body.agentFolder === 'string' ? body.agentFolder : '';
  if (!provider || !model) return { status: 400, body: { error: 'provider and model required' } };
  if (messages.length === 0) return { status: 400, body: { error: 'messages array required' } };

  // OpenAI-compatible Chat Completions for codex (cloud) and local
  // (mlx-omni-server). Claude branch can be added by translating to
  // Anthropic /v1/messages format — skipped today (OpenAI-only class).
  const proxyPrefix =
    provider === 'codex' ? '/openai/v1' : provider === 'local' ? '/omlx/v1' : null;
  if (!proxyPrefix) return { status: 400, body: { error: `direct-chat doesn't support provider ${provider} yet` } };

  const url = `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}${proxyPrefix}/chat/completions`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
      body: JSON.stringify({ model, messages }),
    });
  } catch (err) {
    return { status: 502, body: { error: `proxy unreachable: ${(err as Error).message}` } };
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return { status: upstream.status, body: { error: `upstream ${upstream.status}: ${errText.slice(0, 400)}` } };
  }
  const data = (await upstream.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  const tokensIn = data.usage?.prompt_tokens ?? 0;
  const tokensOut = data.usage?.completion_tokens ?? 0;
  const tokensCached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;

  const catalog = getModelCatalog();
  const entry = catalog.find((e) => e.provider === provider && e.id === model);
  const costUsd = priceFor(entry, tokensIn, tokensOut, tokensCached);

  // Best-effort: record into the agent's pseudo session-outbound so usage
  // aggregation picks it up. Failure is non-fatal.
  if (agentFolder) {
    const group = getAgentGroupByFolder(agentFolder);
    if (group) recordDirectChatUsage(group.id, provider, model, text, tokensIn, tokensOut);
  }

  return { status: 200, body: { text, tokensIn, tokensCached, tokensOut, costUsd, model } };
}
