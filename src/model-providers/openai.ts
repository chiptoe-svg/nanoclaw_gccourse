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

const STATIC_FALLBACK: ModelHint[] = [
  { id: 'gpt-5.5', alias: '5.5', note: NOTES['5.5'] },
  { id: 'gpt-5.4', alias: '5.4', note: NOTES['5.4'] },
  { id: 'gpt-5.4-mini', alias: '5.4mini', note: NOTES['5.4mini'] },
  { id: 'gpt-5.3-codex', alias: '5.3codex', note: NOTES['5.3codex'] },
];

function getAuth(): AuthHeader | null {
  const env = readEnvFile(['OPENAI_API_KEY']);
  if (!env.OPENAI_API_KEY) return null;
  return { name: 'authorization', value: `Bearer ${env.OPENAI_API_KEY}` };
}

function parseId(id: string): ParsedModel | null {
  // Single optional `-<variant>` suffix — rejects multi-segment legacy ids.
  const m = id.match(/^gpt-(\d+)\.(\d+)(?:-([a-z]+))?$/);
  if (!m) return null;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const variant = m[3] ?? '';
  const alias = `${m[1]}.${m[2]}${variant}`;
  return {
    id,
    alias,
    // Within same version, base before mini/codex variants (variant === '' sorts highest)
    rank: [major, minor, variant === '' ? 1 : 0],
  };
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
