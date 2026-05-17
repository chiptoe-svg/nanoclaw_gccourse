import { describe, expect, it, beforeEach } from 'vitest';

import { registerProvider, resetRegistryForTests } from '../../../providers/auth-registry.js';
import { handleProviderAuthStart, getOAuthStateStoreForTests } from './provider-auth.js';

beforeEach(() => {
  resetRegistryForTests();
  getOAuthStateStoreForTests().clear();
  registerProvider({
    id: 'claude',
    displayName: 'Anthropic',
    proxyRoutePrefix: '',
    credentialFileShape: 'mixed',
    oauth: {
      clientId: 'cid-claude',
      authorizeUrl: 'https://example.com/oauth/authorize',
      tokenUrl: 'https://example.com/oauth/token',
      redirectUri: 'https://example.com/code/callback',
      scopes: ['user'],
      refreshGrantBody: (rt, cid) => `grant_type=refresh_token&refresh_token=${rt}&client_id=${cid}`,
      pkce: 'S256',
      authCodeBodyFormat: 'json',
      connectInstructions: 'Sign in then paste the code.',
    },
  });
});

describe('handleProviderAuthStart (paste-back)', () => {
  it('returns 200 with JSON {authorizeUrl, state, instructions, displayName} for known provider', () => {
    const result = handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    expect(result.status).toBe(200);
    const body = result.body as { authorizeUrl: string; state: string; instructions: string; displayName: string };
    expect(body.authorizeUrl).toContain('https://example.com/oauth/authorize');
    expect(body.authorizeUrl).toContain('client_id=cid-claude');
    expect(body.authorizeUrl).toContain('code_challenge_method=S256');
    expect(body.authorizeUrl).toContain('redirect_uri=https%3A%2F%2Fexample.com%2Fcode%2Fcallback');
    expect(body.authorizeUrl).toContain(`state=${encodeURIComponent(body.state)}`);
    expect(body.authorizeUrl).toMatch(/code_challenge=[^&]+/);
    expect(body.instructions).toBe('Sign in then paste the code.');
    expect(body.displayName).toBe('Anthropic');
  });

  it('stores state in TtlMap bound to user_id, providerId, and PKCE verifier', () => {
    handleProviderAuthStart('claude', { userId: 'alice@x.edu' });
    const store = getOAuthStateStoreForTests();
    const entries = [...store.entriesForTest()];
    expect(entries).toHaveLength(1);
    expect(entries[0]![1].userId).toBe('alice@x.edu');
    expect(entries[0]![1].providerId).toBe('claude');
    expect(entries[0]![1].pkceVerifier).toMatch(/^[A-Za-z0-9-._~]+$/);
    expect(entries[0]![1].pkceVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('returns 404 for unknown provider', () => {
    const result = handleProviderAuthStart('nope', { userId: 'alice@x.edu' });
    expect(result.status).toBe(404);
  });

  it('returns 400 when provider has no oauth config', () => {
    registerProvider({
      id: 'apikey-only',
      displayName: 'X',
      proxyRoutePrefix: '/x/',
      credentialFileShape: 'api-key',
      apiKey: { placeholder: 'k' },
    });
    const result = handleProviderAuthStart('apikey-only', { userId: 'alice@x.edu' });
    expect(result.status).toBe(400);
  });
});
