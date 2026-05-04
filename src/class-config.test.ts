/**
 * Unit tests for class-config helpers.
 *
 * The module reads `data/class-config.json` from DATA_DIR. We override
 * DATA_DIR via vi.mock to a tmp dir, write fixtures, and assert.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-class-config-test') };
});
const CONFIG_PATH = path.join(TEST_DIR, 'class-config.json');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { findClassStudent, isClassStudentFolder, readClassConfig } from './class-config.js';

function writeConfig(students: Array<{ name: string; folder: string }>): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      { driveParent: 'parent-id', driveMountRoot: '/tmp/x', kb: null, wiki: null, students },
      null,
      2,
    ),
  );
}

function clearConfig(): void {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('class-config helpers', () => {
  beforeEach(() => clearConfig());
  afterAll(() => clearConfig());

  describe('readClassConfig', () => {
    it('returns null when no class is provisioned', () => {
      expect(readClassConfig()).toBeNull();
    });

    it('parses a valid config blob', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      const cfg = readClassConfig();
      expect(cfg).not.toBeNull();
      expect(cfg!.students).toHaveLength(1);
      expect(cfg!.driveMountRoot).toBe('/tmp/x');
    });
  });

  describe('findClassStudent', () => {
    it('returns the student record for a known folder', () => {
      writeConfig([
        { name: 'Alice', folder: 'student_01' },
        { name: 'Bob', folder: 'student_02' },
      ]);
      expect(findClassStudent('student_02')).toEqual({ name: 'Bob', folder: 'student_02' });
    });

    it('returns null for an unknown folder', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      expect(findClassStudent('student_99')).toBeNull();
    });

    it('returns null when no class is provisioned', () => {
      expect(findClassStudent('student_01')).toBeNull();
    });
  });

  describe('isClassStudentFolder', () => {
    it('is true for a folder in the class config', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      expect(isClassStudentFolder('student_01')).toBe(true);
    });

    it('is false for a folder NOT in the class config', () => {
      writeConfig([{ name: 'Alice', folder: 'student_01' }]);
      expect(isClassStudentFolder('main')).toBe(false);
      expect(isClassStudentFolder('global')).toBe(false);
    });

    it('is false when no class is provisioned (default install)', () => {
      expect(isClassStudentFolder('student_01')).toBe(false);
    });
  });
});
