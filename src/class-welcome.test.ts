/**
 * Unit tests for class-welcome rendering.
 *
 * Verifies:
 *   - default template renders with substitutions filled in
 *   - the override file at data/class-welcome.md takes precedence
 *   - missing/empty drive_url falls back to a neutral string
 *   - whitespace-only override file is ignored (treated as missing)
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-class-welcome-test') };
});
const TEMPLATE_PATH = path.join(TEST_DIR, 'class-welcome.md');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { getClassWelcomeText } from './class-welcome.js';

function clearTestDir(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('getClassWelcomeText', () => {
  beforeEach(() => clearTestDir());
  afterAll(() => clearTestDir());

  it('substitutes {name} and {drive_url} in the default template', () => {
    const text = getClassWelcomeText({ name: 'Alice', driveUrl: 'https://drive.google.com/drive/folders/abc123' });
    expect(text).toContain('Hi Alice!');
    expect(text).toContain('https://drive.google.com/drive/folders/abc123');
    // No leftover unsubstituted placeholders.
    expect(text).not.toContain('{name}');
    expect(text).not.toContain('{drive_url}');
  });

  it('falls back to a neutral message when driveUrl is null', () => {
    const text = getClassWelcomeText({ name: 'Alice', driveUrl: null });
    expect(text).toContain('pending');
    expect(text).not.toContain('{drive_url}');
  });

  it('falls back to a neutral message when driveUrl is empty string', () => {
    const text = getClassWelcomeText({ name: 'Alice', driveUrl: '' });
    expect(text).toContain('pending');
  });

  it('uses data/class-welcome.md when present', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEMPLATE_PATH, 'Hello {name}, your folder: {drive_url}. Bye.');
    const text = getClassWelcomeText({ name: 'Bob', driveUrl: 'https://example.com/x' });
    expect(text).toBe('Hello Bob, your folder: https://example.com/x. Bye.');
  });

  it('replaces ALL occurrences of a placeholder, not just the first', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEMPLATE_PATH, '{name}, hi {name}! See {drive_url} or {drive_url}.');
    const text = getClassWelcomeText({ name: 'Carol', driveUrl: 'X' });
    expect(text).toBe('Carol, hi Carol! See X or X.');
  });

  it('ignores a whitespace-only override file (treats as missing)', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEMPLATE_PATH, '   \n\n  \n');
    const text = getClassWelcomeText({ name: 'Dave', driveUrl: 'https://example.com/y' });
    // Default template content
    expect(text).toContain('Hi Dave!');
    expect(text).toContain('https://example.com/y');
  });

  it('still renders when the override file is unreadable (fallback to default)', () => {
    // No file written → default. Covers the "doesn't exist" branch.
    const text = getClassWelcomeText({ name: 'Eve', driveUrl: 'https://example.com/z' });
    expect(text).toContain('Hi Eve!');
    expect(text).toContain('https://example.com/z');
  });
});
