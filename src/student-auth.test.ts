/**
 * Unit tests for student-auth storage.
 *
 * Exercises the shape validator, path sanitizer, atomic write, and the
 * idempotent delete path. DATA_DIR is overridden to a tmp dir so the
 * tests don't pollute the real data tree.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-student-auth-test') };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  deleteStudentAuth,
  getStudentAuthPath,
  hasStudentAuth,
  isValidCodexAuthJson,
  sanitizeUserIdForPath,
  storeStudentAuth,
} from './student-auth.js';

const VALID_AUTH_JSON = JSON.stringify({
  tokens: {
    access_token: 'sk-access-...',
    refresh_token: 'rt-refresh-...',
    id_token: 'id-...',
  },
  account_id: 'acct-...',
  last_refresh: '2026-05-05T00:00:00Z',
});

function clearTestDir(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

describe('sanitizeUserIdForPath', () => {
  it('translates the channel:id colon to underscore', () => {
    expect(sanitizeUserIdForPath('telegram:12345')).toBe('telegram_12345');
  });

  it('accepts hyphens, dots, alphanumerics', () => {
    expect(sanitizeUserIdForPath('discord_alice.bob-99')).toBe('discord_alice.bob-99');
  });

  it('rejects path traversal attempts', () => {
    expect(() => sanitizeUserIdForPath('telegram:../etc/passwd')).toThrow(/unsafe/);
    expect(() => sanitizeUserIdForPath('a/b')).toThrow(/unsafe/);
    expect(() => sanitizeUserIdForPath('a\\b')).toThrow(/unsafe/);
  });

  it('rejects empty and non-string inputs', () => {
    expect(() => sanitizeUserIdForPath('')).toThrow();
    // @ts-expect-error — runtime check, not type check
    expect(() => sanitizeUserIdForPath(null)).toThrow();
    // @ts-expect-error — runtime check, not type check
    expect(() => sanitizeUserIdForPath(undefined)).toThrow();
  });

  it('rejects exotic characters that could break path semantics', () => {
    expect(() => sanitizeUserIdForPath('alice@school')).toThrow(/unsafe/);
    expect(() => sanitizeUserIdForPath('with space')).toThrow(/unsafe/);
    expect(() => sanitizeUserIdForPath('with\nnewline')).toThrow(/unsafe/);
  });
});

describe('isValidCodexAuthJson', () => {
  it('accepts a minimal Codex-shaped object', () => {
    expect(isValidCodexAuthJson({ tokens: { access_token: 'a', refresh_token: 'r' } })).toBe(true);
  });

  it('accepts extra fields beyond the required ones', () => {
    expect(
      isValidCodexAuthJson({
        tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i' },
        account_id: 'x',
      }),
    ).toBe(true);
  });

  it('rejects missing tokens object', () => {
    expect(isValidCodexAuthJson({})).toBe(false);
    expect(isValidCodexAuthJson({ access_token: 'a', refresh_token: 'r' })).toBe(false);
  });

  it('rejects missing or non-string token fields', () => {
    expect(isValidCodexAuthJson({ tokens: { access_token: 'a' } })).toBe(false);
    expect(isValidCodexAuthJson({ tokens: { refresh_token: 'r' } })).toBe(false);
    expect(isValidCodexAuthJson({ tokens: { access_token: 1, refresh_token: 'r' } })).toBe(false);
    expect(isValidCodexAuthJson({ tokens: null })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isValidCodexAuthJson(null)).toBe(false);
    expect(isValidCodexAuthJson('a string')).toBe(false);
    expect(isValidCodexAuthJson(42)).toBe(false);
    expect(isValidCodexAuthJson(undefined)).toBe(false);
  });
});

describe('storeStudentAuth / getStudentAuthPath / hasStudentAuth / deleteStudentAuth', () => {
  beforeEach(() => clearTestDir());
  afterAll(() => clearTestDir());

  it('round-trips a valid auth.json', () => {
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    const p = getStudentAuthPath('telegram:42');
    expect(p).not.toBeNull();
    expect(fs.readFileSync(p!, 'utf8')).toBe(VALID_AUTH_JSON);
    expect(hasStudentAuth('telegram:42')).toBe(true);
  });

  it('returns null / false for an unknown user', () => {
    expect(getStudentAuthPath('telegram:999')).toBeNull();
    expect(hasStudentAuth('telegram:999')).toBe(false);
  });

  it('returns null for a path-traversal user_id (sanitization fails closed)', () => {
    expect(getStudentAuthPath('telegram:../etc/passwd')).toBeNull();
    expect(hasStudentAuth('telegram:../etc/passwd')).toBe(false);
  });

  it('rejects unparseable JSON', () => {
    expect(() => storeStudentAuth('telegram:1', 'not json')).toThrow(/valid JSON/);
  });

  it('rejects JSON without the required tokens shape', () => {
    expect(() => storeStudentAuth('telegram:1', JSON.stringify({ foo: 'bar' }))).toThrow(/Codex auth.json/);
    expect(() =>
      storeStudentAuth('telegram:1', JSON.stringify({ tokens: { access_token: 'a' } })),
    ).toThrow(/Codex auth.json/);
  });

  it('overwrites existing auth atomically (no .tmp leftover)', () => {
    storeStudentAuth('telegram:7', VALID_AUTH_JSON);
    const second = JSON.stringify({
      tokens: { access_token: 'a2', refresh_token: 'r2' },
    });
    storeStudentAuth('telegram:7', second);
    const p = getStudentAuthPath('telegram:7');
    expect(fs.readFileSync(p!, 'utf8')).toBe(second);
    // No leftover .tmp files
    const dir = path.dirname(p!);
    const stragglers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });

  it('deleteStudentAuth removes the directory', () => {
    storeStudentAuth('telegram:9', VALID_AUTH_JSON);
    expect(hasStudentAuth('telegram:9')).toBe(true);
    deleteStudentAuth('telegram:9');
    expect(hasStudentAuth('telegram:9')).toBe(false);
  });

  it('deleteStudentAuth is idempotent on a non-existent user', () => {
    expect(() => deleteStudentAuth('telegram:never')).not.toThrow();
  });

  it('deleteStudentAuth no-ops on path-traversal user_id (does not throw)', () => {
    expect(() => deleteStudentAuth('telegram:../boom')).not.toThrow();
  });

  it('writes the file with restrictive permissions (0600 on POSIX)', () => {
    storeStudentAuth('telegram:5', VALID_AUTH_JSON);
    const p = getStudentAuthPath('telegram:5')!;
    const mode = fs.statSync(p).mode & 0o777;
    // POSIX: should be 0600. Other OSes (Windows): mode is approximate;
    // assert no group/world bits.
    expect(mode & 0o077).toBe(0);
  });
});
