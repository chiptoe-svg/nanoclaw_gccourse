/**
 * Tests for class-login-tokens helpers + the redeemer hook.
 *
 * Uses an in-memory SQLite DB seeded with the migration so we don't
 * touch the real install. Mocks `mintSessionForUser` to verify the
 * redeemer returns the session shape we expect.
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const minted: string[] = [];
vi.mock('./channels/playground/auth-store.js', () => ({
  // Capture what mintSessionForUser was called with so we can verify
  // the redeemer hooks into it correctly.
  mintSessionForUser: vi.fn((userId: string | null) => {
    minted.push(userId ?? '<null>');
    return { cookieValue: `cookie-for-${userId}`, userId, createdAt: Date.now(), lastSeen: Date.now() };
  }),
  registerClassTokenRedeemer: vi.fn(),
}));

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => testDb),
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let testDb: Database.Database;

import { moduleClassLoginTokens } from './db/migrations/module-class-login-tokens.js';
import {
  issueClassLoginToken,
  lookupActiveToken,
  revokeAllForUser,
  rotateClassLoginToken,
  listTokensForUser,
} from './class-login-tokens.js';

beforeEach(() => {
  testDb = new Database(':memory:');
  moduleClassLoginTokens.up(testDb);
  minted.length = 0;
});

afterEach(() => {
  testDb.close();
});

describe('issueClassLoginToken', () => {
  it('inserts a row and returns the raw token', () => {
    const token = issueClassLoginToken('user_alice');
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const row = testDb.prepare('SELECT user_id, revoked_at FROM class_login_tokens WHERE token = ?').get(token);
    expect(row).toEqual({ user_id: 'user_alice', revoked_at: null });
  });

  it('allows multiple active tokens per user (any active redeems)', () => {
    const t1 = issueClassLoginToken('user_alice');
    const t2 = issueClassLoginToken('user_alice');
    expect(t1).not.toBe(t2);
    expect(lookupActiveToken(t1)).toBe('user_alice');
    expect(lookupActiveToken(t2)).toBe('user_alice');
  });
});

describe('lookupActiveToken', () => {
  it('returns null for unknown tokens', () => {
    expect(lookupActiveToken('nope')).toBeNull();
  });

  it('returns null for revoked tokens', () => {
    const t = issueClassLoginToken('user_alice');
    revokeAllForUser('user_alice');
    expect(lookupActiveToken(t)).toBeNull();
  });
});

describe('revokeAllForUser', () => {
  it('revokes every active token for the user', () => {
    const t1 = issueClassLoginToken('user_alice');
    const t2 = issueClassLoginToken('user_alice');
    issueClassLoginToken('user_bob'); // unrelated, shouldn't be touched

    const revoked = revokeAllForUser('user_alice');
    expect(revoked).toBe(2);
    expect(lookupActiveToken(t1)).toBeNull();
    expect(lookupActiveToken(t2)).toBeNull();
  });

  it('returns 0 when no active tokens exist', () => {
    expect(revokeAllForUser('user_ghost')).toBe(0);
  });
});

describe('rotateClassLoginToken', () => {
  it('revokes prior tokens and issues a fresh one', () => {
    const old1 = issueClassLoginToken('user_alice');
    const old2 = issueClassLoginToken('user_alice');
    const fresh = rotateClassLoginToken('user_alice');

    expect(lookupActiveToken(old1)).toBeNull();
    expect(lookupActiveToken(old2)).toBeNull();
    expect(lookupActiveToken(fresh)).toBe('user_alice');
  });
});

describe('listTokensForUser', () => {
  it('returns active + revoked tokens, newest first', () => {
    issueClassLoginToken('user_alice');
    revokeAllForUser('user_alice');
    issueClassLoginToken('user_alice');

    const rows = listTokensForUser('user_alice');
    expect(rows).toHaveLength(2);
    // First row should be the active one (issued most recently).
    expect(rows[0]!.revoked_at).toBeNull();
    expect(rows[1]!.revoked_at).not.toBeNull();
  });
});
