/**
 * Live model discovery for the `/model` command.
 *
 * Provider-agnostic. Each provider (Claude, OpenAI/Codex, future Gemini/etc.)
 * is an adapter under `src/model-providers/` that knows its own id format,
 * ranking rules, and auth pattern. This file is the dispatcher: take the
 * provider name from the agent group, look up its adapter, fetch its
 * `/v1/models` endpoint, filter + cap, fall back to static on failure.
 *
 * Custom endpoints are first-class. Each adapter declares its env-var name
 * (e.g. `ANTHROPIC_BASE_URL`); when set, that overrides the adapter's
 * default host. Same convention the credential-proxy uses, so configuring
 * once works for both runtime traffic and model-list discovery.
 *
 * Cache: 1 hour in memory, keyed by provider name. The model list rarely
 * changes; refetching every `/model` invocation would burn rate-limit
 * budget for no gain.
 *
 * Test kill-switch: `NANOCLAW_NO_LIVE_MODELS=1` forces the static path
 * regardless of what auth is configured. Used by unit tests so they don't
 * hit the network.
 */
import { request as httpsRequest } from 'https';

import { readEnvFile } from './env.js';
import { log } from './log.js';
import { getModelProvider, listRegisteredProviders } from './model-providers/index.js';
import { STATIC_CLAUDE } from './model-providers/anthropic.js';
import { STATIC_CODEX } from './model-providers/openai.js';
import type { ModelHint, ParsedModel } from './model-providers/types.js';

export type { ModelHint } from './model-providers/types.js';

const MAX_HINTS = 4;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  models: ModelHint[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// ── Live fetch (provider-agnostic) ─────────────────────────────────────────

interface ModelsApiResponse {
  data?: { id: string }[];
}

interface FetchOpts {
  hostname: string;
  port: number;
  path: string;
  headers: Record<string, string>;
}

function httpsGetJson(opts: FetchOpts): Promise<string[] | null> {
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.path,
        method: 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.warn('Model discovery non-200', {
              host: opts.hostname,
              status: res.statusCode,
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as ModelsApiResponse;
            const ids = (json.data ?? []).map((m) => m.id).filter((s): s is string => typeof s === 'string');
            resolve(ids);
          } catch (err) {
            log.warn('Model discovery parse failed', { err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.warn('Model discovery request error', { err: String(err) });
      resolve(null);
    });
    req.end();
  });
}

/**
 * Resolve the host an adapter should call. Reads its declared env-var
 * override (e.g. `OPENAI_BASE_URL`) and parses out hostname + port.
 * Falls back to the adapter's default host on port 443.
 *
 * Custom endpoints might include a path prefix (the credential-proxy uses
 * `http://host:3001/openai/v1` for example). We strip the path here — the
 * adapter declares its own `modelsPath`, and adapters expect to call the
 * upstream host directly, not through the local proxy. Discovery runs on
 * the host where credentials are accessible directly.
 */
function resolveEndpoint(envBaseUrlVar: string, defaultHost: string): { hostname: string; port: number } {
  const env = readEnvFile([envBaseUrlVar]);
  const raw = env[envBaseUrlVar];
  if (!raw) return { hostname: defaultHost, port: 443 };
  try {
    const u = new URL(raw);
    return { hostname: u.hostname, port: u.port ? parseInt(u.port, 10) : u.protocol === 'http:' ? 80 : 443 };
  } catch {
    log.warn('Invalid base URL env, using default', { envVar: envBaseUrlVar, value: raw });
    return { hostname: defaultHost, port: 443 };
  }
}

async function fetchProviderModels(provider: string): Promise<ModelHint[] | null> {
  if (process.env.NANOCLAW_NO_LIVE_MODELS) return null;
  const adapter = getModelProvider(provider);
  if (!adapter) return null;
  const auth = adapter.getAuth();
  if (!auth) return null;

  const endpoint = resolveEndpoint(adapter.envBaseUrlVar, adapter.defaultHost);
  const ids = await httpsGetJson({
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: adapter.modelsPath,
    headers: { ...(adapter.extraHeaders ?? {}), [auth.name]: auth.value },
  });
  if (!ids || ids.length === 0) return null;

  const parsed: ParsedModel[] = ids.map((id) => adapter.parseId(id)).filter((p): p is ParsedModel => p !== null);
  if (parsed.length === 0) return null;

  const top = adapter.pickTop(parsed, MAX_HINTS);
  return top.map((p) => ({
    id: p.id,
    alias: p.alias,
    note: adapter.noteFor(p.alias) ?? '',
  }));
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function hintsForProvider(provider: string | null, force = false): Promise<ModelHint[]> {
  const key = (provider || 'claude').toLowerCase();
  const adapter = getModelProvider(key);
  if (!adapter) return [];

  const now = Date.now();
  if (!force) {
    const cached = cache.get(key);
    if (cached && now < cached.expiresAt) return cached.models;
  }

  const fetched = await fetchProviderModels(key);
  const models = fetched ?? adapter.staticFallback;
  cache.set(key, { models, expiresAt: now + CACHE_TTL_MS });
  return models;
}

/**
 * Resolve a user-typed alias (`opus`, `5.5`, `5.4mini`) to the full model
 * id sent to the provider. Returns the input unchanged if no alias matches —
 * users can always type the full id directly.
 */
export async function expandAlias(provider: string | null, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const hints = await hintsForProvider(provider);
  const match = hints.find((h) => h.alias === trimmed);
  return match ? match.id : trimmed;
}

/** Internal helper for tests — clears the in-memory cache. */
export function _resetCacheForTest(): void {
  cache.clear();
}

// Static fallback re-exports for tests + any consumer that explicitly wants
// the offline-only path.
export { STATIC_CLAUDE, STATIC_CODEX };

// Re-export adapter introspection for `/model help`-style commands and
// future `/add-admintool-model` skill validation.
export { listRegisteredProviders };
