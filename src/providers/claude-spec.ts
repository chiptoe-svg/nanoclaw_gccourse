import { registerProvider } from './auth-registry.js';
import type { ModelEntry } from '../model-catalog.js';

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
    // org:create_api_key was in Claude Code's request set but Anthropic
    // silently drops it on grant (smoke-tested 2026-05-17). Omitted here.
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    refreshGrantBody: (refreshToken, clientId) =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    pkce: 'S256',
    authCodeBodyFormat: 'json',
    connectInstructions: [
      '1. Sign in to your Anthropic account in the new tab.',
      '2. Click "Authorize".',
      '3. Anthropic will display an authorization code on the next page.',
      '4. Copy the code (it may be combined with state separated by "#" — paste the whole thing).',
    ].join('\n'),
  },
  apiKey: {
    placeholder: 'sk-ant-api03-…',
    validatePrefix: 'sk-ant-',
  },
  // Anthropic's haiku/sonnet/opus naturally maps to 3 of the 5 tiers
  // from the 2026-05-28 review — no -pro above opus, no -nano below
  // haiku. Chip/note voice matches the OpenAI catalog so the chat
  // dropdown reads consistently across providers.
  //
  //   claude-opus-4-7    frontier        (== OpenAI gpt-5.5)
  //   claude-sonnet-4-6  daily driver ★  (== OpenAI gpt-5.4)
  //   claude-haiku-4-5   fast/cheap      (== OpenAI gpt-5.4-mini)
  catalogModels: [
    {
      id: 'claude-haiku-4-5',
      modelProvider: 'anthropic',
      displayName: 'claude-haiku-4-5',
      origin: 'cloud',
      costPer1kInUsd: 0.001,
      costPer1kOutUsd: 0.005,
      costPer1kCachedInUsd: 0.0001,
      costPer1kTokensUsd: 0.0008,
      avgLatencySec: 0.9,
      paramCount: 'not disclosed',
      modalities: ['text', 'image'],
      chips: ['☁ Anthropic', '⚡ fast', '$ cheap'],
      notes: 'Fast, efficient haiku tier for responsive tasks and subagents.',
      bestFor: 'Short tasks, classification, subagents — when latency matters more than depth.',
    },
    {
      id: 'claude-sonnet-4-6',
      modelProvider: 'anthropic',
      displayName: 'claude-sonnet-4-6',
      origin: 'cloud',
      costPer1kInUsd: 0.003,
      costPer1kOutUsd: 0.015,
      costPer1kCachedInUsd: 0.0003,
      costPer1kTokensUsd: 0.012,
      avgLatencySec: 2.1,
      paramCount: 'not disclosed',
      modalities: ['text', 'image'],
      chips: ['☁ Anthropic', '⚖ balanced'],
      notes: 'Daily driver — balanced quality + cost. Recommended default for most class work.',
      bestFor: 'Reasoning, long outputs, writing.',
      default: true,
    },
    {
      id: 'claude-opus-4-7',
      modelProvider: 'anthropic',
      displayName: 'claude-opus-4-7',
      origin: 'cloud',
      // Anthropic Opus pricing tier (revise after the next published rate
      // update). Per-1M token rates → divide by 1000 for per-1k.
      costPer1kInUsd: 0.015,
      costPer1kOutUsd: 0.075,
      costPer1kCachedInUsd: 0.0015,
      costPer1kTokensUsd: 0.045,
      avgLatencySec: 3.5,
      paramCount: 'not disclosed',
      modalities: ['text', 'image'],
      chips: ['☁ Anthropic', '🔝 frontier', '$$$ premium'],
      notes: "Anthropic's frontier — headroom above the daily driver for tough problems.",
      bestFor: 'Hardest reasoning, long-form writing, multi-step agentic flows.',
    },
  ] satisfies ModelEntry[],
});
