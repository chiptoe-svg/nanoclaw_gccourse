/**
 * UI-side provider grouping. The Class Controls form and Home Providers
 * card render one row per user-facing group; underneath, each group maps
 * to one or more registered auth-registry spec ids.
 *
 * Why hard-coded: the user-facing list is intentionally a curated 4 — it's
 * the mental model the instructor and students operate on. Registered
 * specs (and the credential-proxy routing keyed on them) stay flexible
 * underneath. See plans/class-controls-provider-grouping.md.
 */
/**
 * Per-group sub-row recipes: how each user-facing group decomposes into
 * connectable auth methods. The instructor LLM Providers card renders
 * one sub-row per entry, mapping label → underlying spec + method:
 *
 *   method: 'oauth'   → opens cred dialog at the spec's OAuth path
 *   method: 'apiKey'  → opens cred dialog at the spec's api-key paste
 *   method: 'settings'→ opens cred dialog 'none' variant (test connection)
 *
 * Notes:
 *   - OpenAI's "API key" routes through `openai-platform`, not the
 *     codex spec's redundant api-key option — keeps the surface simple
 *     and makes Platform vs Subscription the meaningful distinction.
 *   - Anthropic exposes both Claude Code OAuth and the API key on the
 *     same `claude` spec (mixed shape).
 *   - Local + Clemson have no per-user OAuth and the spec doesn't
 *     declare an apiKey shape (it's `'none'`); the migration from C-1
 *     parks the .env-sourced key under the owner's creds silently and
 *     "Settings" opens the existing none-variant dialog.
 */
export const PROVIDER_GROUPS = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    specIds: ['codex', 'openai-platform'],
    subRows: [
      { label: 'ChatGPT subscription', specId: 'codex', method: 'oauth' },
      // An OpenAI Platform API key is functionally the same artifact
      // wherever it's stored — the credential-proxy accepts it on either
      // route. C-1's `.env`-to-owner migration parked OPENAI_API_KEY under
      // codex; reflect that here so the sub-row shows as connected even
      // before the instructor re-pastes into the preferred openai-platform
      // bucket. Paste/Remove still target the preferred spec.
      {
        label: 'Platform API key',
        specId: 'openai-platform',
        method: 'apiKey',
        alsoCheck: ['codex'],
      },
    ],
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    specIds: ['claude'],
    subRows: [
      { label: 'Claude Code OAuth', specId: 'claude', method: 'oauth' },
      { label: 'API key', specId: 'claude', method: 'apiKey' },
    ],
  },
  {
    id: 'local',
    displayName: 'Local (OMLX)',
    specIds: ['omlx'],
    subRows: [{ label: 'Server', specId: 'omlx', method: 'settings' }],
  },
  {
    id: 'clemson',
    displayName: 'Clemson',
    specIds: ['clemson'],
    subRows: [{ label: 'Configured', specId: 'clemson', method: 'settings' }],
  },
];
