import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// vi.mock factories are hoisted above imports, so they can't close over local
// consts. vi.hoisted runs alongside the mock before any `import`.
const { TMP } = vi.hoisted(() => {
  return { TMP: '/tmp/nanoclaw-test-websearch-config' };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TMP };
});

import { readWebSearchProvider, writeWebSearchProvider } from './web-search-config.js';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('web-search config', () => {
  it('defaults to searxng when no file exists', () => {
    expect(readWebSearchProvider()).toBe('searxng');
  });
  it('round-trips a written provider', () => {
    writeWebSearchProvider('brave', 'owner:test');
    expect(readWebSearchProvider()).toBe('brave');
    expect(fs.existsSync(path.join(TMP, 'config', 'web-search.json'))).toBe(true);
  });
  it('falls back to searxng on an unknown stored value', () => {
    fs.mkdirSync(path.join(TMP, 'config'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'config', 'web-search.json'), JSON.stringify({ provider: 'bogus' }));
    expect(readWebSearchProvider()).toBe('searxng');
  });
});
