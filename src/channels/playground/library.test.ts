import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('listLibrary — cost_tokens + latency_ms', () => {
  let tmp: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-library-'));
    cacheDir = path.join(tmp, 'playground', 'library-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // Mark as already-cloned so ensureClone() short-circuits.
    fs.mkdirSync(path.join(cacheDir, '.git'));
    vi.doMock('../../config.js', () => ({ DATA_DIR: tmp }));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeSkill(category: string, name: string, frontmatter: string): void {
    const dir = path.join(cacheDir, category, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\n${frontmatter}\n---\n\n# ${name}\n\nBody.\n`,
    );
  }

  it('extracts costTokens + latencyMs from frontmatter', async () => {
    writeSkill(
      'default',
      'web_search',
      'name: web_search\ndescription: Search the web.\ncost_tokens: 400\nlatency_ms: 600',
    );
    const { listLibrary } = await import('./library.js');
    const entries = listLibrary();
    const ws = entries.find((e) => e.name === 'web_search');
    expect(ws).toBeDefined();
    expect(ws!.costTokens).toBe(400);
    expect(ws!.latencyMs).toBe(600);
  });

  it('leaves costTokens + latencyMs undefined when frontmatter omits them', async () => {
    writeSkill('default', 'calculator', 'name: calculator\ndescription: Adds numbers.');
    const { listLibrary } = await import('./library.js');
    const entries = listLibrary();
    const calc = entries.find((e) => e.name === 'calculator');
    expect(calc).toBeDefined();
    expect(calc!.costTokens).toBeUndefined();
    expect(calc!.latencyMs).toBeUndefined();
  });

  it('ignores non-numeric values', async () => {
    writeSkill(
      'default',
      'broken',
      'name: broken\ndescription: x\ncost_tokens: lots\nlatency_ms: slow',
    );
    const { listLibrary } = await import('./library.js');
    const entries = listLibrary();
    const b = entries.find((e) => e.name === 'broken');
    expect(b).toBeDefined();
    expect(b!.costTokens).toBeUndefined();
    expect(b!.latencyMs).toBeUndefined();
  });
});
