/**
 * Per-student Codex OAuth storage.
 *
 * Filesystem-backed: each student's `auth.json` (the file Codex CLI
 * writes after `codex login`) lives at
 * `data/student-auth/<sanitized_user_id>/auth.json`.
 *
 * No encryption at rest — matches the existing `~/.codex/auth.json`
 * model where the host already stores the instructor's token in plain
 * text. Blast radius is "the host's filesystem"; if that's compromised
 * we're already in trouble.
 *
 * The codex provider (src/providers/codex.ts) calls
 * `getStudentAuthPath(userId)` at session spawn to find the right
 * source for the per-session auth.json copy, falling back to the
 * instructor's host auth when the student hasn't authed yet.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const STORAGE_SUBDIR = 'student-auth';

/**
 * Convert a user_id (e.g. `telegram:12345`) into a path-safe slug.
 * Anything outside [A-Za-z0-9._-] is rejected — defensive against any
 * future channel that might use exotic characters in user IDs.
 */
export function sanitizeUserIdForPath(userId: string): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('userId is required');
  }
  // Replace ':' with '_' as the canonical translation; reject anything
  // outside the safe-set after that. This is deliberately strict — we
  // store credentials, so a path-traversal bug here is a security bug.
  const slug = userId.replace(/:/g, '_');
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) {
    throw new Error(`userId contains characters that are unsafe for paths: ${userId}`);
  }
  return slug;
}

function studentDir(userId: string): string {
  return path.join(DATA_DIR, STORAGE_SUBDIR, sanitizeUserIdForPath(userId));
}

function studentAuthFile(userId: string): string {
  return path.join(studentDir(userId), 'auth.json');
}

/**
 * Validate that the JSON looks like a Codex-style `auth.json`. We do a
 * shape check rather than a deep equality check so future Codex schema
 * tweaks don't force us to redeploy.
 *
 * Required: a `tokens` object with both `access_token` and
 * `refresh_token` strings. (Codex's auth.json typically also has
 * `account_id`, `last_refresh`, `id_token`, etc. — we don't require
 * those.)
 */
export function isValidCodexAuthJson(raw: unknown): raw is { tokens: { access_token: string; refresh_token: string } } {
  if (typeof raw !== 'object' || raw === null) return false;
  const tokens = (raw as { tokens?: unknown }).tokens;
  if (typeof tokens !== 'object' || tokens === null) return false;
  const t = tokens as Record<string, unknown>;
  return typeof t.access_token === 'string' && typeof t.refresh_token === 'string';
}

/**
 * Persist a student's Codex auth.json contents. Validates JSON shape
 * before writing — refuses random text, malformed JSON, or shapes that
 * don't look like Codex auth files. Writes atomically (temp file +
 * rename) so a crash mid-write can't leave a partial credential.
 *
 * Throws on validation or filesystem failure. Idempotent — a second
 * call with new contents replaces the old file.
 */
export function storeStudentAuth(userId: string, authJsonText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJsonText);
  } catch {
    throw new Error('auth.json is not valid JSON');
  }
  if (!isValidCodexAuthJson(parsed)) {
    throw new Error(
      'auth.json does not look like a Codex auth.json (missing tokens.access_token or tokens.refresh_token)',
    );
  }

  const dir = studentDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = studentAuthFile(userId);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, authJsonText, { mode: 0o600 });
  fs.renameSync(tmpPath, finalPath);
  log.info('student-auth stored', { userId });
}

/**
 * Path to a stored auth.json, or null if the student hasn't uploaded
 * one yet. Caller (codex provider) checks for null and falls back to
 * the instructor's host auth.
 */
export function getStudentAuthPath(userId: string): string | null {
  try {
    const p = studentAuthFile(userId);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null; // sanitization rejected the user_id — treat as "not stored"
  }
}

export function hasStudentAuth(userId: string): boolean {
  return getStudentAuthPath(userId) !== null;
}

/**
 * Remove a student's stored auth (e.g. on revoke / re-pair with a
 * different account). Idempotent — silently no-ops if nothing is
 * stored. Sanitization failures also no-op (nothing to delete).
 */
export function deleteStudentAuth(userId: string): void {
  let dir: string;
  try {
    dir = studentDir(userId);
  } catch {
    return;
  }
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    log.info('student-auth deleted', { userId });
  }
}
