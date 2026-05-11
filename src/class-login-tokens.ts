/**
 * Class login tokens — long-lived per-roster URL tokens.
 *
 * Each row in `class_login_tokens` is one durable token a student can
 * bookmark. The playground's `GET /?token=...` handler (in trunk's
 * `server.ts`) looks them up via the redeemer this module registers
 * at import time, then issues a session cookie via
 * `mintSessionForUser`. Token = identity; session = authenticated
 * browser.
 *
 * Operations:
 *   - `issueClassLoginToken(userId)` — mint a fresh token, return it.
 *   - `revokeAllForUser(userId)` — mark every active token for a user
 *     as revoked. Used by rotate before issuing a fresh one.
 *   - `lookupActiveToken(token)` — find the user_id for a non-revoked
 *     token. Used by the redeemer hook.
 *   - `listTokensForUser(userId)` — used by the CLI list/rotate
 *     commands so the instructor can see the current state.
 *
 * Lives on the `classroom` branch (per rule 5). Installed by
 * `/add-classroom`; not part of trunk's baseline.
 */
import crypto from 'crypto';

import { getDb } from './db/connection.js';
import { log } from './log.js';
import {
  mintSessionForUser,
  registerClassTokenRedeemer,
  type PlaygroundSession,
} from './channels/playground/auth-store.js';

const TOKEN_BYTES = 24; // 24 bytes → 48 hex chars; ample entropy.

export interface ClassLoginTokenRow {
  token: string;
  user_id: string;
  created_at: string;
  revoked_at: string | null;
}

function randomTokenString(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Mint a fresh token for `userId` and persist it. Returns the raw
 * token string the caller should embed in a URL.
 */
export function issueClassLoginToken(userId: string): string {
  const token = randomTokenString();
  const createdAt = new Date().toISOString();
  getDb()
    .prepare('INSERT INTO class_login_tokens (token, user_id, created_at, revoked_at) VALUES (?, ?, ?, NULL)')
    .run(token, userId, createdAt);
  return token;
}

/**
 * Mark every currently-active token for `userId` as revoked. Returns
 * the number of rows updated. Idempotent: a no-op when the user has
 * no active tokens.
 */
export function revokeAllForUser(userId: string): number {
  const revokedAt = new Date().toISOString();
  const info = getDb()
    .prepare('UPDATE class_login_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(revokedAt, userId);
  return info.changes;
}

/**
 * Resolve a raw token to its `user_id`. Returns null when the token
 * doesn't exist or has been revoked.
 */
export function lookupActiveToken(token: string): string | null {
  const row = getDb()
    .prepare('SELECT user_id FROM class_login_tokens WHERE token = ? AND revoked_at IS NULL')
    .get(token) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

/**
 * Every token (active + revoked) for a user, newest first. Used by
 * the CLI's `list` and `rotate` commands.
 */
export function listTokensForUser(userId: string): ClassLoginTokenRow[] {
  return getDb()
    .prepare(
      'SELECT token, user_id, created_at, revoked_at FROM class_login_tokens WHERE user_id = ? ORDER BY created_at DESC',
    )
    .all(userId) as ClassLoginTokenRow[];
}

/**
 * Convenience for the rotate flow: revoke any active tokens, then
 * mint a fresh one. Returns the new token.
 */
export function rotateClassLoginToken(userId: string): string {
  revokeAllForUser(userId);
  return issueClassLoginToken(userId);
}

/**
 * The redeemer registered with the playground auth-store. Called when
 * a `GET /?token=...` request comes in. Looks the token up; if active,
 * mints a session for the resolved user_id and returns it. Otherwise
 * returns null and the request falls through to the normal auth flow.
 */
function classTokenRedeemer(token: string): PlaygroundSession | null {
  let userId: string | null;
  try {
    userId = lookupActiveToken(token);
  } catch (err) {
    // DB not initialized yet (very early in startup) or other transient
    // failure — log and fall through. Better to refuse one login than to
    // crash the server.
    log.warn('class-login-tokens redeemer DB error', { err: String(err) });
    return null;
  }
  if (!userId) return null;
  log.info('Class login token redeemed', { userId });
  return mintSessionForUser(userId);
}

registerClassTokenRedeemer(classTokenRedeemer);
