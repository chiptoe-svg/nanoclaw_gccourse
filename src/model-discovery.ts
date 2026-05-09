/**
 * Live model discovery for the `/model` command.
 *
 * Hits each provider's `/v1/models` endpoint, filters to currently-relevant
 * IDs, caps at 4, and produces short typeable aliases so users can switch
 * with `/model opus` or `/model 5.5` instead of the long IDs.
 *
 * Hybrid by design: we still ship a hardcoded fallback list so `/model`
 * always works — when the network call fails (no auth, offline, upstream
 * 5xx), we serve the static list and the user never sees a degradation.
 *
 * Cache: 1 hour in memory. The model list rarely changes; refetching every
 * `/model` invocation would burn upstream rate-limit budget for no gain.
 *
 * Auth: reuses the same credentials the credential-proxy uses (env API key
 * preferred, OAuth token from `~/.claude/.credentials.json` as fallback for
 * Anthropic). For Codex we hit OpenAI's `/v1/models` with `OPENAI_API_KEY`;
 * if it isn't set, we fall back to the static list silently — Codex users
 * on ChatGPT subscription mode without an API key just see hardcoded hints.
 */
import fs from 'fs';
import path from 'path';
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export interface ModelHint {
  /** Full model id sent to the provider. */
  id: string;
  /** Short alias users can type. Equal to `id` when no useful shortening exists. */
  alias: string;
  /** One-line description. Curated where we recognize the id; empty otherwise. */
  note: string;
}

// ── Curated notes ──────────────────────────────────────────────────────────
// Keyed by alias so newly-released models inherit the same descriptions when
// they bump the underlying id. Match by alias means `5.5` keeps its note when
// the full id moves from `gpt-5.5` to whatever OpenAI calls it next.

const NOTES_BY_ALIAS: Record<string, string> = {
  // Claude
  opus: 'Opus — strongest reasoning',
  sonnet: 'Sonnet — balanced',
  haiku: 'Haiku — fast/cheap',
  // Codex (gpt-5.x family)
  '5.5': 'strongest — complex coding, research, knowledge work',
  '5.4': 'rollout fallback if 5.5 unavailable',
  '5.4mini': 'fast/cheap for light tasks, subagents',
  '5.3': 'older codex variant',
  '5.3codex': 'older codex-tuned',
};

// ── Static fallback (used when the live fetch fails) ───────────────────────

const STATIC_CLAUDE: ModelHint[] = [
  { id: 'claude-opus-4-7', alias: 'opus', note: NOTES_BY_ALIAS.opus },
  { id: 'claude-sonnet-4-6', alias: 'sonnet', note: NOTES_BY_ALIAS.sonnet },
  { id: 'claude-haiku-4-5-20251001', alias: 'haiku', note: NOTES_BY_ALIAS.haiku },
];

const STATIC_CODEX: ModelHint[] = [
  { id: 'gpt-5.5', alias: '5.5', note: NOTES_BY_ALIAS['5.5'] },
  { id: 'gpt-5.4', alias: '5.4', note: NOTES_BY_ALIAS['5.4'] },
  { id: 'gpt-5.4-mini', alias: '5.4mini', note: NOTES_BY_ALIAS['5.4mini'] },
  { id: 'gpt-5.3-codex', alias: '5.3codex', note: NOTES_BY_ALIAS['5.3codex'] },
];

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
interface CacheEntry {
  models: ModelHint[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// ── Aliasing ───────────────────────────────────────────────────────────────

/**
 * Claude id pattern: `claude-<tier>-<major>-<minor>[-<date>]`.
 * Tier is one of opus/sonnet/haiku — the alias.
 */
function aliasForClaude(id: string): string | null {
  const m = id.match(/^claude-(opus|sonnet|haiku)-/);
  return m ? m[1] : null;
}

/**
 * Codex id pattern: `gpt-<version>[-<variant>][-<variant>]...`.
 * Alias drops `gpt-` and dashes between version and variant: `gpt-5.4-mini` → `5.4mini`.
 */
function aliasForCodex(id: string): string | null {
  // Single optional `-<variant>` suffix. Rejects multi-segment legacy ids
  // like `gpt-3.5-turbo-instruct` (two suffixes) and embedding/dall-e ids.
  const m = id.match(/^gpt-(\d+\.\d+(?:-[a-z]+)?)$/);
  if (!m) return null;
  return m[1].replace(/-/g, '');
}

// ── Filtering + ranking ────────────────────────────────────────────────────

interface ClaudeRanked {
  id: string;
  tier: 'opus' | 'sonnet' | 'haiku';
  major: number;
  minor: number;
  date: number;
}

function parseClaudeId(id: string): ClaudeRanked | null {
  const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return {
    id,
    tier: m[1] as ClaudeRanked['tier'],
    major: parseInt(m[2], 10),
    minor: parseInt(m[3], 10),
    date: m[4] ? parseInt(m[4], 10) : 0,
  };
}

function pickTopClaude(rawIds: string[]): ModelHint[] {
  const parsed = rawIds.map(parseClaudeId).filter((x): x is ClaudeRanked => x !== null);
  // Group by tier, take latest of each
  const latestByTier = new Map<string, ClaudeRanked>();
  for (const p of parsed) {
    const cur = latestByTier.get(p.tier);
    if (
      !cur ||
      p.major > cur.major ||
      (p.major === cur.major && p.minor > cur.minor) ||
      (p.major === cur.major && p.minor === cur.minor && p.date > cur.date)
    ) {
      latestByTier.set(p.tier, p);
    }
  }
  // Display order: opus, sonnet, haiku (most-capable first; users are scanning for
  // "what does the strongest do" and reading top-down).
  const order: ClaudeRanked['tier'][] = ['opus', 'sonnet', 'haiku'];
  return order
    .map((tier) => latestByTier.get(tier))
    .filter((x): x is ClaudeRanked => x !== undefined)
    .map((p) => ({ id: p.id, alias: p.tier, note: NOTES_BY_ALIAS[p.tier] ?? '' }))
    .slice(0, 4);
}

interface CodexRanked {
  id: string;
  alias: string;
  major: number;
  minor: number;
  variant: string; // '' for the base, otherwise mini/turbo/codex/etc.
}

function parseCodexId(id: string): CodexRanked | null {
  // Match the same single-suffix shape as `aliasForCodex` — keeps the two
  // functions in lockstep so a model that gets an alias is also rankable.
  const m = id.match(/^gpt-(\d+)\.(\d+)(?:-([a-z]+))?$/);
  if (!m) return null;
  const alias = aliasForCodex(id);
  if (!alias) return null;
  return {
    id,
    alias,
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    variant: m[3] ?? '',
  };
}

function pickTopCodex(rawIds: string[]): ModelHint[] {
  const parsed = rawIds.map(parseCodexId).filter((x): x is CodexRanked => x !== null);
  // Sort by version desc; among same version, base before variants (-mini, -codex).
  parsed.sort((a, b) => {
    if (b.major !== a.major) return b.major - a.major;
    if (b.minor !== a.minor) return b.minor - a.minor;
    return a.variant.localeCompare(b.variant); // '' sorts before 'mini' before 'codex'
  });
  // Cap at 4
  return parsed.slice(0, 4).map((p) => ({
    id: p.id,
    alias: p.alias,
    note: NOTES_BY_ALIAS[p.alias] ?? '',
  }));
}

// ── Auth helpers (reuse credential-proxy patterns) ─────────────────────────

interface ClaudeCredsFile {
  claudeAiOauth?: { accessToken: string };
}

function getAnthropicAuthHeader(): { name: string; value: string } | null {
  const env = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']);
  if (env.ANTHROPIC_API_KEY) return { name: 'x-api-key', value: env.ANTHROPIC_API_KEY };
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
  if (oauth) return { name: 'authorization', value: `Bearer ${oauth}` };
  // Fallback to ~/.claude/.credentials.json access token
  try {
    const credPath = path.join(process.env.HOME || '/home/node', '.claude', '.credentials.json');
    if (fs.existsSync(credPath)) {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as ClaudeCredsFile;
      const token = creds.claudeAiOauth?.accessToken;
      if (token) return { name: 'authorization', value: `Bearer ${token}` };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function getOpenAIKey(): string | null {
  const env = readEnvFile(['OPENAI_API_KEY']);
  return env.OPENAI_API_KEY || null;
}

// ── Live fetchers ──────────────────────────────────────────────────────────

interface ModelsApiResponse {
  data?: { id: string }[];
}

function fetchModels(opts: {
  hostname: string;
  path: string;
  headers: Record<string, string>;
}): Promise<string[] | null> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: opts.hostname,
        port: 443,
        path: opts.path,
        method: 'GET',
        headers: { ...opts.headers, 'anthropic-version': '2023-06-01' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.warn('Model discovery non-200', {
              host: opts.hostname,
              status: res.statusCode,
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as ModelsApiResponse;
            const ids = (json.data ?? []).map((m) => m.id).filter((s): s is string => typeof s === 'string');
            resolve(ids);
          } catch (err) {
            log.warn('Model discovery parse failed', { err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.warn('Model discovery request error', { err: String(err) });
      resolve(null);
    });
    req.end();
  });
}

async function fetchClaudeModels(): Promise<ModelHint[] | null> {
  // Test-only kill-switch: tests set this so the discovery returns the
  // static fallback deterministically without mocking the network stack.
  if (process.env.NANOCLAW_NO_LIVE_MODELS) return null;
  const auth = getAnthropicAuthHeader();
  if (!auth) return null;
  const ids = await fetchModels({
    hostname: 'api.anthropic.com',
    path: '/v1/models',
    headers: { [auth.name]: auth.value },
  });
  if (!ids || ids.length === 0) return null;
  return pickTopClaude(ids);
}

async function fetchCodexModels(): Promise<ModelHint[] | null> {
  if (process.env.NANOCLAW_NO_LIVE_MODELS) return null;
  const key = getOpenAIKey();
  if (!key) return null;
  const ids = await fetchModels({
    hostname: 'api.openai.com',
    path: '/v1/models',
    headers: { authorization: `Bearer ${key}` },
  });
  if (!ids || ids.length === 0) return null;
  return pickTopCodex(ids);
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function hintsForProvider(provider: string | null, force = false): Promise<ModelHint[]> {
  const key = (provider || 'claude').toLowerCase();
  if (key !== 'claude' && key !== 'codex') return [];

  const now = Date.now();
  if (!force) {
    const cached = cache.get(key);
    if (cached && now < cached.expiresAt) return cached.models;
  }

  const fetched = key === 'claude' ? await fetchClaudeModels() : await fetchCodexModels();
  const models = fetched ?? (key === 'claude' ? STATIC_CLAUDE : STATIC_CODEX);
  cache.set(key, { models, expiresAt: now + CACHE_TTL_MS });
  return models;
}

/**
 * Resolve a user-typed alias (e.g. `opus`, `5.5`, `5.4mini`) to the full model
 * id sent to the provider. Returns the input unchanged if no alias matches —
 * users can always type the full id directly.
 */
export async function expandAlias(provider: string | null, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const hints = await hintsForProvider(provider);
  const match = hints.find((h) => h.alias === trimmed);
  return match ? match.id : trimmed;
}

/** Internal helper for tests — clears the in-memory cache. */
export function _resetCacheForTest(): void {
  cache.clear();
}

// Re-exported for the static fallback consumers.
export { STATIC_CLAUDE, STATIC_CODEX, pickTopClaude, pickTopCodex, aliasForClaude, aliasForCodex };
