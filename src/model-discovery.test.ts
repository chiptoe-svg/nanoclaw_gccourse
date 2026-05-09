import { describe, it, expect, beforeEach } from 'vitest';

import {
  STATIC_CLAUDE,
  STATIC_CODEX,
  _resetCacheForTest,
  aliasForClaude,
  aliasForCodex,
  expandAlias,
  hintsForProvider,
  pickTopClaude,
  pickTopCodex,
} from './model-discovery.js';

beforeEach(() => {
  _resetCacheForTest();
  // Disable live network fetches so tests use the deterministic static
  // fallback regardless of what credentials happen to be on the host.
  process.env.NANOCLAW_NO_LIVE_MODELS = '1';
});

describe('aliasForClaude', () => {
  it.each([
    ['claude-opus-4-7', 'opus'],
    ['claude-sonnet-4-6', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
  ])('%s → %s', (id, expected) => {
    expect(aliasForClaude(id)).toBe(expected);
  });

  it('returns null for unknown ids', () => {
    expect(aliasForClaude('claude-2')).toBeNull();
    expect(aliasForClaude('gpt-5.5')).toBeNull();
    expect(aliasForClaude('')).toBeNull();
  });
});

describe('aliasForCodex', () => {
  it.each([
    ['gpt-5.5', '5.5'],
    ['gpt-5.4', '5.4'],
    ['gpt-5.4-mini', '5.4mini'],
    ['gpt-5.3-codex', '5.3codex'],
  ])('%s → %s', (id, expected) => {
    expect(aliasForCodex(id)).toBe(expected);
  });

  it('returns null for unknown ids', () => {
    expect(aliasForCodex('claude-opus-4-7')).toBeNull();
    expect(aliasForCodex('gpt-3.5-turbo-instruct')).toBeNull(); // dashed-version-suffix unsupported here
    expect(aliasForCodex('davinci-002')).toBeNull();
  });
});

describe('pickTopClaude', () => {
  it('returns latest of each tier in opus → sonnet → haiku order', () => {
    const ids = [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-haiku-4-5-20251001',
      'claude-haiku-3-5',
      'claude-2', // ignored — doesn't match pattern
    ];
    const out = pickTopClaude(ids);
    expect(out.map((m) => m.alias)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(out[0].id).toBe('claude-opus-4-7');
    expect(out[1].id).toBe('claude-sonnet-4-6');
    expect(out[2].id).toBe('claude-haiku-4-5-20251001');
  });

  it('handles partial coverage (only sonnet available)', () => {
    const out = pickTopClaude(['claude-sonnet-4-6']);
    expect(out).toHaveLength(1);
    expect(out[0].alias).toBe('sonnet');
  });

  it('caps at 4 entries (no more than one per tier — total ≤ 3)', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `claude-opus-4-${i}`);
    const out = pickTopClaude(ids);
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it('attaches curated note for known aliases', () => {
    const out = pickTopClaude(['claude-opus-4-7']);
    expect(out[0].note).toMatch(/Opus/);
  });
});

describe('pickTopCodex', () => {
  it('sorts newest first (descending major.minor) with base before mini/codex variants', () => {
    const ids = ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'];
    const out = pickTopCodex(ids);
    expect(out.map((m) => m.alias)).toEqual(['5.5', '5.4', '5.4mini', '5.3codex']);
  });

  it('caps at 4 entries', () => {
    const ids = [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3',
      'gpt-5.3-codex',
      'gpt-5.2',
    ];
    const out = pickTopCodex(ids);
    expect(out).toHaveLength(4);
  });

  it('drops non-matching ids (old gpt-3.x, embeddings, etc.)', () => {
    const ids = ['gpt-5.5', 'gpt-3.5-turbo-instruct', 'davinci-002', 'text-embedding-ada-002'];
    const out = pickTopCodex(ids);
    expect(out).toHaveLength(1);
    expect(out[0].alias).toBe('5.5');
  });
});

describe('hintsForProvider (with no API key configured)', () => {
  it('falls back to STATIC_CLAUDE when fetch returns null', async () => {
    // No env vars or credentials file → fetch returns null → fallback
    const out = await hintsForProvider('claude');
    expect(out).toEqual(STATIC_CLAUDE);
  });

  it('falls back to STATIC_CODEX when fetch returns null', async () => {
    const out = await hintsForProvider('codex');
    expect(out).toEqual(STATIC_CODEX);
  });

  it('returns [] for unknown provider', async () => {
    const out = await hintsForProvider('mystery-vendor');
    expect(out).toEqual([]);
  });

  it('caches the result for the TTL window', async () => {
    const a = await hintsForProvider('claude');
    const b = await hintsForProvider('claude');
    expect(a).toBe(b); // identity equality — second call hit the cache
  });
});

describe('expandAlias', () => {
  it('returns the input if no alias matches', async () => {
    expect(await expandAlias('claude', 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(await expandAlias('claude', 'something-else')).toBe('something-else');
  });

  it('expands a known alias to the full id', async () => {
    // Cache will hold STATIC_CLAUDE since no auth is configured in tests.
    const out = await expandAlias('claude', 'opus');
    expect(out).toBe(STATIC_CLAUDE[0].id);
  });

  it('expands codex aliases', async () => {
    expect(await expandAlias('codex', '5.5')).toBe('gpt-5.5');
    expect(await expandAlias('codex', '5.4mini')).toBe('gpt-5.4-mini');
  });

  it('trims whitespace before lookup', async () => {
    expect(await expandAlias('codex', '  5.5  ')).toBe('gpt-5.5');
  });
});
