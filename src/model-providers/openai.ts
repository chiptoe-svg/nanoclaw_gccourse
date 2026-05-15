/**
 * OpenAI / Codex model adapter.
 *
 * Id pattern: `gpt-<major>.<minor>[-<variant>]` where `<variant>` is one
 * of `mini` / `codex` / `turbo` / etc. Single-suffix only — multi-segment
 * legacy ids like `gpt-3.5-turbo-instruct` are rejected so the listing
 * stays focused on currently-relevant models.
 *
 * Alias drops `gpt-` and dashes between version and variant: `gpt-5.4-mini`
 * → `5.4mini`. Top-N is purely sort-by-version; no tier grouping (unlike
 * Claude) since the variants aren't strict capability tiers.
 *
 * Same adapter handles OpenAI-compat endpoints (OpenRouter, vLLM, Ollama
 * in API mode, LiteLLM, custom corporate proxies) as long as they speak
 * `/v1/models` and use Bearer auth. Set `OPENAI_BASE_URL` in `.env` to
 * point at the alternate host; the credential-proxy already honors the
 * same variable for runtime traffic, so configuring once works for both
 * the proxy and `/model` discovery.
 */
import { readEnvFile } from '../env.js';
import type { AuthHeader, ModelHint, ModelProviderAdapter, ParsedModel } from './types.js';

const NOTES: Record<string, string> = {
  '5.5': 'strongest — complex coding, research, knowledge work',
  '5.4': 'rollout fallback if 5.5 unavailable',
  '5.4mini': 'fast/cheap for light tasks, subagents',
  '5.3': 'older codex variant',
  '5.3codex': 'older codex-tuned',
};

/**
 * Codex-accepted model ids. The bare `gpt-5`, `gpt-5-mini`, etc. line up
 * with what codex CLI 0.124+ actually targets; the dotted-decimal
 * variants are codex-internal aliases for the same underlying upstream
 * models (translated by codex-app-server when forwarding).
 *
 * OpenAI's /v1/models returns its full catalog (gpt-4o, embeddings,
 * dall-e, whisper, etc.) — most of those aren't valid codex `model`
 * values. We filter discovery to this whitelist so the Models tab
 * surfaces only ids the user can actually pick.
 *
 * To allow a new id: append here and either ship via BUILTIN_ENTRIES
 * (for everyone) or add to config/model-catalog-local.json with full
 * pricing metadata (per-install).
 */
const CODEX_WHITELIST = new Set<string>([
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-codex',
  'gpt-5-codex-mini',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
]);

const STATIC_FALLBACK: ModelHint[] = [
  { id: 'gpt-5-codex', alias: '5codex', note: 'codex default — code-tuned GPT-5' },
  { id: 'gpt-5', alias: '5', note: 'general-purpose GPT-5' },
  { id: 'gpt-5-mini', alias: '5mini', note: 'fast/cheap variant' },
];

function getAuth(): AuthHeader | null {
  const env = readEnvFile(['OPENAI_API_KEY']);
  if (!env.OPENAI_API_KEY) return null;
  return { name: 'authorization', value: `Bearer ${env.OPENAI_API_KEY}` };
}

function parseId(id: string): ParsedModel | null {
  // Whitelist-gated: only ids codex actually accepts. The two id shapes
  // we encounter — `gpt-5[-variant]` (current codex CLI) and dotted
  // `gpt-N.M[-variant]` (codex-internal aliases) — both flow through
  // this single regex and are then checked against CODEX_WHITELIST.
  if (!CODEX_WHITELIST.has(id)) return null;
  // Dotted: `gpt-5.4-mini` → alias `5.4mini`. Bare: `gpt-5-mini` → `5mini`.
  const dotted = id.match(/^gpt-(\d+)\.(\d+)(?:-([a-z]+(?:-[a-z]+)?))?$/);
  if (dotted) {
    const major = parseInt(dotted[1], 10);
    const minor = parseInt(dotted[2], 10);
    const variant = dotted[3] ?? '';
    return {
      id,
      alias: `${dotted[1]}.${dotted[2]}${variant}`,
      rank: [major, minor, variant === '' ? 1 : 0],
    };
  }
  const bare = id.match(/^gpt-(\d+)(?:-([a-z]+(?:-[a-z]+)?))?$/);
  if (bare) {
    const major = parseInt(bare[1], 10);
    const variant = bare[2] ?? '';
    return {
      id,
      // Display as `5codex` / `5mini` etc. — drop the gpt- prefix + dash.
      alias: `${bare[1]}${variant}`,
      rank: [major, 0, variant === '' ? 1 : 0],
    };
  }
  return null;
}

function pickTop(parsed: ParsedModel[], maxCount: number): ParsedModel[] {
  const sorted = [...parsed].sort((a, b) => {
    const cmp = compareRankDesc(a.rank, b.rank);
    if (cmp !== 0) return cmp;
    // Tie-break: alias asc for stable ordering
    return a.alias.localeCompare(b.alias);
  });
  return sorted.slice(0, maxCount);
}

/** Component-wise compare, descending. Higher rank tuple sorts first. */
function compareRankDesc(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return bv - av;
  }
  return 0;
}

const adapter: ModelProviderAdapter = {
  name: 'codex',
  defaultHost: 'api.openai.com',
  envBaseUrlVar: 'OPENAI_BASE_URL',
  modelsPath: '/v1/models',
  getAuth,
  parseId,
  pickTop,
  noteFor: (alias) => NOTES[alias],
  staticFallback: STATIC_FALLBACK,
};

// Registration happens in `./index.ts`. See the comment in anthropic.ts.
export { adapter as openaiAdapter, NOTES as CODEX_NOTES, STATIC_FALLBACK as STATIC_CODEX };
