import fs from 'fs';

import { MODEL_CATALOG_LOCAL_PATH } from './config.js';

export interface ModelEntry {
  /** Stable id, used in container.json allowedModels and chat-tab dropdowns. */
  id: string;
  provider: 'claude' | 'codex' | 'opencode' | 'ollama' | string;
  displayName: string;
  /** "cloud" | "local" — drives card styling and whether host/context/etc. show. */
  origin: 'cloud' | 'local';

  /**
   * Cost per 1k tokens (USD) — 0 for local. Legacy single-rate field;
   * still consulted by older surfaces when split rates aren't available.
   * For accurate cost: use the In/Out/Cached fields below.
   */
  costPer1kTokensUsd?: number;
  /** Cost per 1k input tokens (USD). */
  costPer1kInUsd?: number;
  /** Cost per 1k output tokens (USD). Typically 4-5× input for cloud models. */
  costPer1kOutUsd?: number;
  /**
   * Cost per 1k cached-input tokens (USD). Anthropic prompt caching is
   * billed at ~10% of input rate; OpenAI prompt caching at ~50%. Absent
   * for providers without prompt caching.
   */
  costPer1kCachedInUsd?: number;
  /** Average latency in seconds — best-effort estimate. */
  avgLatencySec?: number;
  /** Parameter count display string ("70B", "8B", "?"). */
  paramCount?: string;
  /** Modalities the model accepts. */
  modalities?: ('text' | 'image' | 'audio')[];
  /** Free-form notes (instructor-authored on a class deployment for local entries). */
  notes?: string;

  /** Local-only: where the OpenAI-compatible endpoint lives. */
  host?: string;
  /** Local-only: context window size in tokens. */
  contextSize?: number;
  /** Local-only: quantization tag. */
  quantization?: string;

  /** Pedagogical chips ("⚡ fast", "$ cheap", "🐢 slower", "🆓 free", etc.). */
  chips?: string[];
  /** Suggested-use blurb. */
  bestFor?: string;
  /**
   * Marks this entry as the recommended default for its provider. Used by
   * the playground Models tab to visually distinguish "this is the entry
   * to pick if you have no preference" from "this is the entry the agent
   * is currently using." At most one per provider; if multiple are flagged
   * the UI picks the first.
   */
  default?: boolean;
}

const BUILTIN_ENTRIES: ModelEntry[] = [
  {
    id: 'claude-haiku-4-5',
    provider: 'claude',
    displayName: 'claude-haiku-4-5',
    origin: 'cloud',
    costPer1kInUsd: 0.001,
    costPer1kOutUsd: 0.005,
    costPer1kCachedInUsd: 0.0001,
    costPer1kTokensUsd: 0.0008,
    avgLatencySec: 0.9,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ Anthropic'],
    bestFor: 'Short answers, classification, structured output.',
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'claude',
    displayName: 'claude-sonnet-4-6',
    origin: 'cloud',
    costPer1kInUsd: 0.003,
    costPer1kOutUsd: 0.015,
    costPer1kCachedInUsd: 0.0003,
    costPer1kTokensUsd: 0.012,
    avgLatencySec: 2.1,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['🐢 slower', '$$ pricier', '☁ Anthropic'],
    bestFor: 'Reasoning, long outputs.',
    default: true,
  },
  {
    id: 'gpt-5-mini',
    provider: 'codex',
    displayName: 'gpt-5-mini',
    origin: 'cloud',
    costPer1kInUsd: 0.00025,
    costPer1kOutUsd: 0.002,
    costPer1kCachedInUsd: 0.000125,
    costPer1kTokensUsd: 0.0006,
    avgLatencySec: 1.0,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ OpenAI'],
    bestFor: 'Quick, broad-knowledge tasks.',
    default: true,
  },
  {
    id: 'gpt-5',
    provider: 'codex',
    displayName: 'gpt-5',
    origin: 'cloud',
    costPer1kInUsd: 0.00125,
    costPer1kOutUsd: 0.01,
    costPer1kCachedInUsd: 0.000625,
    costPer1kTokensUsd: 0.005,
    avgLatencySec: 2.5,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI'],
    bestFor: 'General-purpose, well-rounded.',
  },
  {
    id: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
    provider: 'local',
    displayName: 'Qwen 3.6 (35B, MLX 4-bit)',
    origin: 'local',
    costPer1kTokensUsd: 0,
    avgLatencySec: 8,
    paramCount: '35B',
    modalities: ['text', 'image'],
    notes: 'Runs on the host Mac. Free, no quota — but slower than cloud.',
    host: 'http://localhost:8000',
    contextSize: 32768,
    quantization: 'MLX 4-bit',
    chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
    bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
    default: true,
  },
];

function readLocalEntries(): ModelEntry[] {
  if (!fs.existsSync(MODEL_CATALOG_LOCAL_PATH)) return [];
  try {
    const raw = fs.readFileSync(MODEL_CATALOG_LOCAL_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((e: ModelEntry) => ({ ...e, origin: 'local' as const }));
  } catch {
    return [];
  }
}

export function getModelCatalog(): ModelEntry[] {
  // Local-file entries win over built-ins with the same provider+id, so
  // an operator's local-catalog-local.json acts as an override layer
  // (used by the Models tab's edit / set-default flows).
  const localEntries = readLocalEntries();
  const localIds = new Set(localEntries.map((e) => `${e.provider}:${e.id}`));
  const builtins = BUILTIN_ENTRIES.filter((e) => !localIds.has(`${e.provider}:${e.id}`));
  return [...builtins, ...localEntries];
}
