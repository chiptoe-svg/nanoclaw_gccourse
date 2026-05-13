import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getModelCatalog', () => {
  let tmp: string;
  let localPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    localPath = path.join(tmp, 'local.json');
    vi.doMock('./config.js', () => ({ MODEL_CATALOG_LOCAL_PATH: localPath }));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns the bundled cloud entries when local file is empty', async () => {
    fs.writeFileSync(localPath, '[]');
    const { getModelCatalog } = await import('./model-catalog.js');
    const catalog = getModelCatalog();
    expect(catalog.find((e) => e.id === 'claude-haiku-4-5')).toBeTruthy();
    expect(catalog.find((e) => e.id === 'claude-sonnet-4-6')).toBeTruthy();
    expect(catalog.find((e) => e.origin === 'local')).toBeUndefined();
  });

  it('appends local entries from the JSON file', async () => {
    fs.writeFileSync(
      localPath,
      JSON.stringify([
        {
          id: 'llama-3.3-70b-instruct',
          provider: 'ollama',
          displayName: 'llama-3.3-70b-instruct',
          origin: 'local',
          host: 'http://192.168.1.42:11434',
          contextSize: 32768,
          quantization: 'Q4_K_M',
          paramCount: '70B',
          modalities: ['text'],
          notes: 'Best for short factual queries.',
        },
      ]),
    );
    const { getModelCatalog } = await import('./model-catalog.js');
    const local = getModelCatalog().filter((e) => e.origin === 'local');
    expect(local).toHaveLength(1);
    expect(local[0]!.host).toBe('http://192.168.1.42:11434');
  });

  it('returns empty local section when file does not exist', async () => {
    // localPath intentionally not created
    const { getModelCatalog } = await import('./model-catalog.js');
    expect(getModelCatalog().filter((e) => e.origin === 'local')).toEqual([]);
  });
});
