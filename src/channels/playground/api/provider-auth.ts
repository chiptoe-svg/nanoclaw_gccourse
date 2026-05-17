/**
 * OAuth + API-key HTTP handlers for per-student provider auth (paste-back flow).
 *
 * Routes (registered in playground/server.ts):
 *   GET    /provider-auth/:provider/start      → handleProviderAuthStart
 *                                                returns JSON { authorizeUrl, state, instructions, displayName }
 *   POST   /provider-auth/:provider/exchange   → handleProviderAuthExchange (Task 9)
 *                                                body { code, state }
 *   GET    /api/me/providers/:id               → handleGetProviderStatus (Task 10)
 *   POST   /api/me/providers/:id/api-key       → handlePostApiKey (Task 10)
 *   POST   /api/me/providers/:id/active        → handleSetActive (Task 10)
 *   DELETE /api/me/providers/:id               → handleDisconnect (Task 10)
 *
 * PKCE S256, single-use state tokens via TtlMap. State binds to user_id
 * + providerId + PKCE verifier; exchange enforces single-use via take().
 * Vendor's own redirect_uri (from spec.oauth.redirectUri) is sent unchanged
 * since the vendor OAuth clients are pinned to vendor-controlled URLs —
 * see docs/providers/oauth-endpoints.md.
 */
import crypto from 'crypto';

import { getProviderSpec } from '../../../providers/auth-registry.js';
import { TtlMap } from '../ttl-map.js';
import type { ApiResult } from './me.js';

const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthStateEntry {
  userId: string;
  providerId: string;
  pkceVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const oauthStateStore = new TtlMap<string, OAuthStateEntry>(STATE_TTL_MS);

export function getOAuthStateStoreForTests(): TtlMap<string, OAuthStateEntry> {
  return oauthStateStore;
}

function randomBase64Url(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export function handleProviderAuthStart(
  providerId: string,
  session: { userId: string },
): ApiResult<unknown> {
  const spec = getProviderSpec(providerId);
  if (!spec) return { status: 404, body: { error: `unknown provider: ${providerId}` } };
  if (!spec.oauth) return { status: 400, body: { error: `provider ${providerId} has no oauth config` } };

  const state = randomBase64Url(32);
  const pkceVerifier = randomBase64Url(64);
  const codeChallenge = s256(pkceVerifier);

  oauthStateStore.set(state, {
    userId: session.userId,
    providerId,
    pkceVerifier,
    redirectUri: spec.oauth.redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: spec.oauth.clientId,
    redirect_uri: spec.oauth.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    scope: spec.oauth.scopes.join(' '),
  });

  return {
    status: 200,
    body: {
      authorizeUrl: `${spec.oauth.authorizeUrl}?${params.toString()}`,
      state,
      instructions: spec.oauth.connectInstructions,
      displayName: spec.displayName,
    },
  };
}
