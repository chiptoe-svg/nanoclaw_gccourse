import { registerProvider } from './auth-registry.js';
import type { ModelEntry } from '../model-catalog.js';
import { OPENAI_CATALOG } from './openai-catalog.js';

// Values sourced from docs/providers/oauth-endpoints.md (Codex v0.124.0).
// Re-verify after major @openai/codex version bumps.
// Note: codex CLI's redirectUri is `http://localhost:<ephemeral>/auth/callback`
// — a loopback listener for the CLI's own desktop flow. For NanoClaw's
// web-driven paste-back flow we use the loopback form below; OpenAI's
// OAuth server accepts loopback URIs for this client. The actual port
// doesn't matter — the user never lands on it (paste-back).
registerProvider({
  id: 'codex',
  displayName: 'OpenAI subscription',
  proxyRoutePrefix: '/openai/',
  credentialFileShape: 'mixed',
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    pkce: 'S256',
    authCodeBodyFormat: 'form',
    connectInstructions: [
      '1. Sign in to your OpenAI account in the new tab.',
      '2. Click "Authorize".',
      '3. Your browser will try to load "localhost:1455" and FAIL — this is expected.',
      '4. Look at the URL bar. It will show:',
      '   http://localhost:1455/auth/callback?code=ac_...&state=...',
      '5. Copy the entire URL (or just the value of the "code" parameter) and paste below.',
    ].join('\n'),
  },
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
  // Codex model entries — IDs + descriptions + pricing pulled verbatim
  // from OpenAI's docs:
  //   https://developers.openai.com/codex/models
  //   https://developers.openai.com/api/docs/pricing
  // Per-1M tokens → per-1k (divide by 1000). Update when OpenAI ships new
  // codex models or revises pricing — the auto-refresh task on the
  // post-class punch list will eventually keep this in sync automatically.
  // Catalog comes from the shared OPENAI_CATALOG — same lineup as
  // openai-platform-spec.ts. Tagged with the codex modelProvider name
  // since that's what container_configs.model_provider stores when an
  // agent routes through the ChatGPT subscription OAuth path.
  catalogModels: OPENAI_CATALOG.map((m) => ({ ...m, modelProvider: 'openai-codex' })) satisfies ModelEntry[],
});
