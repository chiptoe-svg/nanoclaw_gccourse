import { readContainerConfig, writeContainerConfig } from '../../../container-config.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';
import { listAllForProvider } from '../../../model-discovery.js';

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

    return {
      status: 200,
      body: {
        catalog,
        allowedModels: cfg.allowedModels ?? [],
        discovered,
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
