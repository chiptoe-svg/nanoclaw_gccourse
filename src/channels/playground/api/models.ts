import fs from 'fs';
import path from 'path';

import { MODEL_CATALOG_LOCAL_PATH } from '../../../config.js';
import { readContainerConfig, writeContainerConfig } from '../../../container-config.js';
import { readEnvFile } from '../../../env.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';
import { listAllForProvider } from '../../../model-discovery.js';
import { setModel } from '../../../model-switch.js';
import { setProvider } from '../../../provider-switch.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export interface DiscoveredModel {
  provider: 'claude' | 'codex' | 'local';
  id: string;
}

export interface ModelsResponse {
  catalog: ModelEntry[];
  allowedModels: { provider: string; model: string }[];
  discovered: DiscoveredModel[];
  activeModel: { provider: string; model: string } | null;
  /**
   * Reachability of the local OpenAI-compatible server (mlx-omni-server etc.).
   * Probed server-side because the browser-side fetch sees a *different*
   * "localhost" when accessing the playground over the LAN. `null` when the
   * probe itself failed for a reason unrelated to reachability (timeout etc.).
   */
  localServerOnline: boolean | null;
}

async function probeLocalServer(): Promise<boolean> {
  const env = readEnvFile(['OMLX_BASE_URL']);
  const baseUrl = (process.env.OMLX_BASE_URL ?? env.OMLX_BASE_URL ?? 'http://localhost:8000').replace(/\/$/, '');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleGetModels(draftFolder: string): Promise<ApiResult<ModelsResponse>> {
  try {
    const cfg = readContainerConfig(draftFolder);
    const catalog = getModelCatalog();
    const catalogIds = new Set(catalog.map((m) => `${m.provider}:${m.id}`));

    const [claudeHints, codexHints, localHints, localServerOnline] = await Promise.all([
      listAllForProvider('claude').catch(() => []),
      listAllForProvider('codex').catch(() => []),
      listAllForProvider('local').catch(() => []),
      probeLocalServer(),
    ]);

    const discovered: DiscoveredModel[] = [];
    for (const h of claudeHints) {
      if (!catalogIds.has(`claude:${h.id}`)) discovered.push({ provider: 'claude', id: h.id });
    }
    for (const h of codexHints) {
      if (!catalogIds.has(`codex:${h.id}`)) discovered.push({ provider: 'codex', id: h.id });
    }
    for (const h of localHints) {
      if (!catalogIds.has(`local:${h.id}`)) discovered.push({ provider: 'local', id: h.id });
    }

    const activeModel = cfg.provider && cfg.model ? { provider: cfg.provider, model: cfg.model } : null;

    return {
      status: 200,
      body: {
        catalog,
        allowedModels: cfg.allowedModels ?? [],
        discovered,
        activeModel,
        localServerOnline,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handlePutModels(
  draftFolder: string,
  body: { allowedModels?: unknown },
): ApiResult<{ ok: true; allowedModels: { provider: string; model: string }[] }> {
  if (!Array.isArray(body.allowedModels)) {
    return { status: 400, body: { error: 'allowedModels must be an array' } };
  }
  for (const e of body.allowedModels) {
    const entry = e as Record<string, unknown>;
    if (typeof entry?.provider !== 'string' || typeof entry?.model !== 'string') {
      return { status: 400, body: { error: 'each entry needs string provider + model' } };
    }
  }
  const allowedModels = body.allowedModels as { provider: string; model: string }[];
  try {
    const cfg = readContainerConfig(draftFolder);
    cfg.allowedModels = allowedModels;
    writeContainerConfig(draftFolder, cfg);
    return { status: 200, body: { ok: true, allowedModels } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handlePutActiveModel(
  draftFolder: string,
  body: { provider?: unknown; model?: unknown },
): ApiResult<{ ok: true; activeModel: { provider: string; model: string } }> {
  if (typeof body.provider !== 'string' || typeof body.model !== 'string') {
    return { status: 400, body: { error: 'provider and model are required strings' } };
  }
  const provider = body.provider;
  const model = body.model;
  try {
    // Read current provider — if it's changing, route through setProvider
    // so sessions + agent_groups + running containers stay in sync. If
    // only the model is changing, just update container.json.
    const cfg = readContainerConfig(draftFolder);
    const currentProvider = cfg.provider ?? 'claude';
    if (currentProvider !== provider) {
      const result = setProvider(draftFolder, provider);
      if (!result.ok && result.reason !== 'no-change') {
        return { status: 500, body: { error: `provider switch failed: ${result.reason}` } };
      }
    }
    // Persist model to the DB — agent_groups.model is the source of truth that
    // ensureRuntimeFields syncs into container.json on every spawn. Writing
    // only to container.json (as this handler used to) gets silently clobbered
    // on the next container start when the DB-driven sync runs.
    if (!setModel(draftFolder, model)) {
      return { status: 500, body: { error: 'setModel failed (agent group not found by folder)' } };
    }
    // Re-read after potential setProvider write, then mirror the model into
    // container.json so the current on-disk state matches the DB without
    // waiting for the next spawn-time sync.
    const updated = readContainerConfig(draftFolder);
    updated.model = model;
    writeContainerConfig(draftFolder, updated);
    return { status: 200, body: { ok: true, activeModel: { provider, model } } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

/**
 * Append (or replace) a curated catalog entry in config/model-catalog-local.json.
 * Lets the Models tab promote a discovered-only model into a richer card
 * without hand-editing JSON. Dedupes on `provider:id` — re-saving the same
 * model replaces the previous entry rather than duplicating.
 */
export function handlePutLocalCatalogEntry(body: { entry?: unknown }): ApiResult<{ ok: true; entry: ModelEntry }> {
  const entry = body.entry as Partial<ModelEntry> | undefined;
  if (!entry || typeof entry !== 'object') {
    return { status: 400, body: { error: 'entry object required' } };
  }
  if (typeof entry.id !== 'string' || !entry.id) return { status: 400, body: { error: 'entry.id required' } };
  if (typeof entry.provider !== 'string' || !entry.provider)
    return { status: 400, body: { error: 'entry.provider required' } };
  if (typeof entry.displayName !== 'string' || !entry.displayName)
    return { status: 400, body: { error: 'entry.displayName required' } };

  // Coerce origin from provider if absent: cloud for claude/codex, local for local.
  const origin: 'cloud' | 'local' = entry.origin === 'local' || entry.origin === 'cloud'
    ? entry.origin
    : entry.provider === 'local'
      ? 'local'
      : 'cloud';

  const clean: ModelEntry = {
    id: entry.id,
    provider: entry.provider,
    displayName: entry.displayName,
    origin,
    ...(typeof entry.paramCount === 'string' ? { paramCount: entry.paramCount } : {}),
    ...(Array.isArray(entry.modalities) ? { modalities: entry.modalities as ('text' | 'image' | 'audio')[] } : {}),
    ...(typeof entry.contextSize === 'number' ? { contextSize: entry.contextSize } : {}),
    ...(typeof entry.quantization === 'string' ? { quantization: entry.quantization } : {}),
    ...(typeof entry.avgLatencySec === 'number' ? { avgLatencySec: entry.avgLatencySec } : {}),
    ...(typeof entry.costPer1kTokensUsd === 'number' ? { costPer1kTokensUsd: entry.costPer1kTokensUsd } : {}),
    ...(typeof entry.host === 'string' ? { host: entry.host } : {}),
    ...(typeof entry.notes === 'string' ? { notes: entry.notes } : {}),
    ...(typeof entry.bestFor === 'string' ? { bestFor: entry.bestFor } : {}),
    ...(Array.isArray(entry.chips) ? { chips: entry.chips as string[] } : {}),
  };

  try {
    let arr: ModelEntry[] = [];
    if (fs.existsSync(MODEL_CATALOG_LOCAL_PATH)) {
      const raw = fs.readFileSync(MODEL_CATALOG_LOCAL_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed as ModelEntry[];
    } else {
      fs.mkdirSync(path.dirname(MODEL_CATALOG_LOCAL_PATH), { recursive: true });
    }
    arr = arr.filter((e) => !(e.provider === clean.provider && e.id === clean.id));
    arr.push(clean);
    fs.writeFileSync(MODEL_CATALOG_LOCAL_PATH, JSON.stringify(arr, null, 2) + '\n');
    return { status: 200, body: { ok: true, entry: clean } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
