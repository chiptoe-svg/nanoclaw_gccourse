import { registerProvider } from './auth-registry.js';

// Values sourced from docs/providers/oauth-endpoints.md (Claude Code v2.1.116).
// Re-verify after major @anthropic-ai/claude-code version bumps.
registerProvider({
  id: 'claude',
  displayName: 'Anthropic',
  proxyRoutePrefix: '', // anthropic is the default route in credential-proxy
  credentialFileShape: 'mixed',
  oauth: {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.com/cai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scopes: [
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }).toString(),
    pkce: 'S256',
  },
  apiKey: {
    placeholder: 'sk-ant-api03-…',
    validatePrefix: 'sk-ant-',
  },
});
