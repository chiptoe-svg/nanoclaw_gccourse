import { describe, it, expect } from 'vitest';
import { getProviderSpec } from './auth-registry.js';
import './openai-platform-spec.js';

describe('openai-platform-spec', () => {
  it('registers as id="openai-platform" with apiKey-only credential shape', () => {
    const spec = getProviderSpec('openai-platform');
    expect(spec).not.toBeNull();
    expect(spec!.credentialFileShape).toBe('api-key');
    expect(spec!.oauth).toBeUndefined();
    expect(spec!.apiKey).toBeDefined();
    expect(spec!.apiKey!.placeholder).toMatch(/^sk-/);
  });

  it('ships gpt-4o, gpt-4o-mini, and o3-mini catalog entries', () => {
    const spec = getProviderSpec('openai-platform');
    const ids = spec!.catalogModels!.map((m) => m.id).sort();
    expect(ids).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
    for (const entry of spec!.catalogModels!) {
      expect(entry.modelProvider).toBe('openai-platform');
    }
  });

  it('proxyRoutePrefix is /openai-platform/', () => {
    const spec = getProviderSpec('openai-platform');
    expect(spec!.proxyRoutePrefix).toBe('/openai-platform/');
  });
});
