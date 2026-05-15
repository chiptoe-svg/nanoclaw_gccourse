import fs from 'fs';

import { MODEL_CATALOG_LOCAL_PATH } from './config.js';

export interface ModelEntry {
  /** Stable id, used in container.json allowedModels and chat-tab dropdowns. */
  id: string;
  provider: 'claude' | 'codex' | 'opencode' | 'ollama' | string;
  displayName: string;
  /** "cloud" | "local" — drives card styling and whether host/context/etc. show. */
  origin: 'cloud' | 'local';

  /** Cost per 1k tokens (USD) — 0 for local. */
  costPer1kTokensUsd?: number;
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
    costPer1kTokensUsd: 0.0006,
    avgLatencySec: 1.0,
    paramCount: 'not disclosed',
    modalities: ['text', 'image'],
    chips: ['⚡ fast', '$ cheap', '☁ OpenAI'],
    bestFor: 'Quick, broad-knowledge tasks.',
    default: true,
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
  return [...BUILTIN_ENTRIES, ...readLocalEntries()];
}
