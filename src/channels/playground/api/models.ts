import { readContainerConfig, writeContainerConfig } from '../../../container-config.js';
import { type ModelEntry, getModelCatalog } from '../../../model-catalog.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export interface ModelsResponse {
  catalog: ModelEntry[];
  allowedModels: { provider: string; model: string }[];
}

export function handleGetModels(draftFolder: string): ApiResult<ModelsResponse> {
  try {
    const cfg = readContainerConfig(draftFolder);
    return {
      status: 200,
      body: {
        catalog: getModelCatalog(),
        allowedModels: cfg.allowedModels ?? [],
      },
    };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handlePutModels(
  draftFolder: string,
  body: { allowedModels: { provider: string; model: string }[] },
): ApiResult<{ ok: true; allowedModels: { provider: string; model: string }[] }> {
  if (!Array.isArray(body.allowedModels)) {
    return { status: 400, body: { error: 'allowedModels must be an array' } };
  }
  for (const e of body.allowedModels) {
    if (typeof e?.provider !== 'string' || typeof e?.model !== 'string') {
      return { status: 400, body: { error: 'each entry needs string provider + model' } };
    }
  }
  try {
    const cfg = readContainerConfig(draftFolder);
    cfg.allowedModels = body.allowedModels;
    writeContainerConfig(draftFolder, cfg);
    return { status: 200, body: { ok: true, allowedModels: body.allowedModels } };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
