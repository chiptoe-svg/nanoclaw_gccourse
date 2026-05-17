import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  process.chdir(tmpRoot);
  fs.mkdirSync(path.join(tmpRoot, 'config'), { recursive: true });
  // Reset module cache so `PROJECT_ROOT = process.cwd()` in src/config.ts
  // re-evaluates against the per-test tmpRoot. Without this, the second
  // test sees CONFIG_PATH frozen against the first test's (now deleted)
  // tmp directory.
  vi.resetModules();
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('class-controls — new wrapped shape', () => {
  it('returns sensible defaults when no file exists', async () => {
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.codex).toEqual({
      allow: true,
      provideDefault: true,
      allowByo: true,
    });
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.claude).toEqual({
      allow: true,
      provideDefault: false,
      allowByo: true,
    });
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.local).toEqual({
      allow: true,
      provideDefault: true,
      allowByo: false,
    });
  });

  it('migrates an existing flat-shape file on read', async () => {
    fs.writeFileSync(
      path.join(tmpRoot, 'config', 'class-controls.json'),
      JSON.stringify({
        tabsVisibleToStudents: ['home', 'chat'],
        providersAvailable: ['claude', 'codex'],
        authModesAvailable: ['api-key'],
      }),
    );
    const { readClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const cc = readClassControls();
    expect(cc.classes[DEFAULT_CLASS_ID]!.tabsVisibleToStudents).toEqual(['home', 'chat']);
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.claude!.allow).toBe(true);
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.codex!.allow).toBe(true);
    // 'local' was not in the old array → allow=false in migration
    expect(cc.classes[DEFAULT_CLASS_ID]!.providers.local!.allow).toBe(false);
  });

  it('round-trips through write+read', async () => {
    const { readClassControls, writeClassControls, DEFAULT_CLASS_ID } = await import('./class-controls.js');
    const before = readClassControls();
    before.classes[DEFAULT_CLASS_ID]!.providers.claude!.provideDefault = true;
    writeClassControls(before);
    const after = readClassControls();
    expect(after.classes[DEFAULT_CLASS_ID]!.providers.claude!.provideDefault).toBe(true);
  });

  it('handlePutClassControls rejects writes to non-default class IDs in v1', async () => {
    const { handlePutClassControls } = await import('./class-controls.js');
    const result = handlePutClassControls({
      classes: { 'fake-class': { tabsVisibleToStudents: [], authModesAvailable: [], providers: {} } },
    } as never);
    expect(result.status).toBe(400);
  });
});
