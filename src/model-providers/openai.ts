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
import { LEGACY_CODEX_IDS, OPENAI_CATALOG } from '../providers/openai-catalog.js';
import type { AuthHeader, ModelHint, ModelProviderAdapter, ParsedModel } from './types.js';

// Notes sourced verbatim from https://developers.openai.com/codex/models
// (OpenAI's canonical codex model documentation).
const NOTES: Record<string, string> = {
  '5.5pro': 'frontier-max; longer thinking budgets, premium tier',
  '5.5': 'frontier; complex reasoning + coding',
  '5.4': 'default — balanced quality/cost; daily driver',
  '5.4mini': 'fast/efficient; responsive coding, subagents',
  '5.4nano': 'ultra-cheap; penny-per-turn subagents, classification',
  // Legacy aliases for ids that left the curated catalog but stay
  // discoverable via LEGACY_CODEX_IDS (see openai-catalog.ts).
  '5.3codex': 'industry-leading coding model for complex software engineering',
  '5.3codex-spark': 'research preview, text-only; ChatGPT Pro only',
  '5.2': 'previous-generation general-purpose',
};

/**
 * Codex-accepted model ids. Source of truth: OpenAI's docs page
 * https://developers.openai.com/codex/models. The dotted-decimal
 * `gpt-N.M[-variant]` shape is what codex CLI accepts via its --model
 * flag and what the app-server forwards via turn/start.
 *
 * OpenAI's /v1/models returns its full catalog (gpt-4o, embeddings,
 * dall-e, whisper, etc.) — most of those aren't valid codex `model`
 * values. We filter discovery to this whitelist so the Models tab
 * surfaces only ids the user can actually pick.
 *
 * To allow a new id when OpenAI ships one: append here. To ship pricing
 * metadata for it: add a corresponding BUILTIN_ENTRIES entry in
 * src/model-catalog.ts, or per-install via config/model-catalog-local.json.
 */
// Whitelist derived from the shared OPENAI_CATALOG so adding a new
// curated model becomes a one-file edit. LEGACY_CODEX_IDS lists ids
// that have left the curated catalog but should still pass the gate
// — existing container_configs.model_provider rows that reference
// them keep dispatching through codex without "unrecognised model"
// errors. Add to LEGACY_CODEX_IDS when retiring a model; remove when
// no DB row references it.
const CODEX_WHITELIST = new Set<string>([...OPENAI_CATALOG.map((m) => m.id), ...LEGACY_CODEX_IDS]);

// Discovery fallback when /v1/models can't be reached. Alias drops the
// gpt- prefix AND collapses the dash between version and variant
// (`gpt-5.4-mini` → `5.4mini`) to match parseId's alias output, which
// the Telegram /model picker matches against.
function aliasOf(id: string): string {
  return id.replace(/^gpt-/, '').replace(/(\d)-([a-z])/g, '$1$2');
}
const STATIC_FALLBACK: ModelHint[] = OPENAI_CATALOG.map((m) => ({
  id: m.id,
  alias: aliasOf(m.id),
  note: NOTES[aliasOf(m.id)] ?? '',
}));

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
