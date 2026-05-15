import { readContainerConfig, writeContainerConfig } from '../../../container-config.js';
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
}

export async function handleGetModels(draftFolder: string): Promise<ApiResult<ModelsResponse>> {
  try {
    const cfg = readContainerConfig(draftFolder);
    const catalog = getModelCatalog();
    const catalogIds = new Set(catalog.map((m) => `${m.provider}:${m.id}`));

    const [claudeHints, codexHints, localHints] = await Promise.all([
      listAllForProvider('claude').catch(() => []),
      listAllForProvider('codex').catch(() => []),
      listAllForProvider('local').catch(() => []),
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
