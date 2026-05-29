/**
 * Single source of truth for OpenAI model catalog entries.
 *
 * Both `codex-spec.ts` (ChatGPT subscription via codex OAuth) and
 * `openai-platform-spec.ts` (Platform API key) expose the same set of
 * gpt-5.x models — same ids, same pricing, same chips — they just
 * route through different proxy paths with different auth headers.
 *
 * Adding a new model: edit this file. Both spec catalogs pick it up
 * automatically, and `src/model-providers/openai.ts` derives its
 * CODEX_WHITELIST from the ids so the discovery whitelist can't drift
 * out of sync with the catalog.
 *
 * Pricing notes: OpenAI doesn't publish a programmatic pricing API.
 * Rates come from https://platform.openai.com/docs/pricing — divide
 * the per-1M figures by 1000 for per-1k. When a new model ships
 * without published rates, omit the cost fields rather than guess;
 * the cost aggregator falls back to $0 (conservative).
 */
import type { ModelEntry } from '../model-catalog.js';

/** Catalog entries without the `modelProvider` field — the two spec
 *  files supply that based on which proxy path they route through. */
export type OpenAiCatalogEntry = Omit<ModelEntry, 'modelProvider'>;

/**
 * Tier ladder per the 2026-05-28 review (Option B): frontier-max →
 * frontier → daily driver (default ★) → fast/cheap → ultra-cheap nano.
 */
export const OPENAI_CATALOG: OpenAiCatalogEntry[] = [
  {
    id: 'gpt-5.5-pro',
    displayName: 'gpt-5.5-pro',
    origin: 'cloud',
    // Pricing not on OpenAI's published page yet — omit rather than guess.
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '🔝 frontier', '$$$ premium'],
    notes:
      'Frontier-max tier — extends gpt-5.5 with stronger reasoning and longer thinking budgets. May be subscription-tier-gated on ChatGPT EDU/Plus.',
    bestFor: 'Hardest reasoning, complex multi-step planning, research.',
  },
  {
    id: 'gpt-5.5',
    displayName: 'gpt-5.5',
    origin: 'cloud',
    costPer1kInUsd: 0.005,
    costPer1kOutUsd: 0.03,
    costPer1kCachedInUsd: 0.0005,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '🔝 frontier'],
    notes:
      "OpenAI's frontier model — complex coding, computer use, knowledge work. Headroom above the daily driver for tough problems.",
    bestFor: 'Hard reasoning + multi-step coding when 5.4 isn’t enough.',
  },
  {
    id: 'gpt-5.4',
    displayName: 'gpt-5.4',
    origin: 'cloud',
    costPer1kInUsd: 0.0025,
    costPer1kOutUsd: 0.015,
    costPer1kCachedInUsd: 0.00025,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '⚖ balanced'],
    notes: 'Daily driver — balanced quality + cost. Recommended default for most class work.',
    bestFor: 'Professional work blending coding with broader agentic flows.',
    default: true,
  },
  {
    id: 'gpt-5.4-mini',
    displayName: 'gpt-5.4-mini',
    origin: 'cloud',
    costPer1kInUsd: 0.00075,
    costPer1kOutUsd: 0.0045,
    costPer1kCachedInUsd: 0.000075,
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '⚡ fast', '$ cheap'],
    notes: 'Fast, efficient mini for responsive tasks and subagents.',
    bestFor: 'Short tasks, classification, subagents — when latency matters more than depth.',
  },
  {
    id: 'gpt-5.4-nano',
    displayName: 'gpt-5.4-nano',
    origin: 'cloud',
    // Pricing not on OpenAI's published page yet — omit rather than guess.
    modalities: ['text', 'image'],
    chips: ['☁ OpenAI', '⚡ ultra-fast', '$ cheapest'],
    notes: 'Smallest 5.4-family variant — cheapest and fastest, lighter capability.',
    bestFor: 'Penny-per-turn subagents, classification, lookups.',
  },
];

/**
 * Ids of legacy models that the discovery whitelist must continue to
 * recognise even after they leave the curated catalog — so existing
 * `container_configs.model_provider` rows that reference them keep
 * dispatching through codex without "unrecognised model" errors. Add
 * to this list when retiring a model from OPENAI_CATALOG; remove only
 * when the corresponding `model_provider` DB rows have been migrated.
 */
export const LEGACY_CODEX_IDS: readonly string[] = ['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'];
