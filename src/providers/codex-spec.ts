import { registerProvider } from './auth-registry.js';

// Values sourced from docs/providers/oauth-endpoints.md (Codex v0.124.0).
// Re-verify after major @openai/codex version bumps.
// Note: codex CLI's redirectUri is `http://localhost:<ephemeral>/auth/callback`
// — a loopback listener for the CLI's own desktop flow. For NanoClaw's
// web-driven paste-back flow we use the loopback form below; OpenAI's
// OAuth server accepts loopback URIs for this client. The actual port
// doesn't matter — the user never lands on it (paste-back).
registerProvider({
  id: 'codex',
  displayName: 'OpenAI',
  proxyRoutePrefix: '/openai/',
  credentialFileShape: 'mixed',
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    redirectUri: 'http://localhost:1455/auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
    pkce: 'S256',
  },
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
});
