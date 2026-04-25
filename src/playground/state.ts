/**
 * Playground state.
 *
 * Two kinds of state:
 *
 * 1. AUTH state — global, at .nanoclaw/playground/auth.json. Holds the HMAC
 *    cookie secret and the shared password hash. Shared across all drafts.
 *
 * 2. DRAFT state — per draft, at .nanoclaw/playground/<draft>/state.json.
 *    Holds the dirty flag, last-synced target hash, and trace verbosity.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { AUTH_STATE_FILE, PLAYGROUND_DIR, getDraftPaths } from './paths.js';

// ---------------------------------------------------------------------------
// Auth state — global
// ---------------------------------------------------------------------------

export interface AuthState {
  cookieSecret: string;
  passwordHash: string;
}

const DEFAULT_PASSWORD = 'godfrey';

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function loadAuthState(): AuthState {
  fs.mkdirSync(PLAYGROUND_DIR, { recursive: true });
  if (!fs.existsSync(AUTH_STATE_FILE)) {
    const fresh: AuthState = {
      cookieSecret: crypto.randomBytes(32).toString('hex'),
      passwordHash: sha256(DEFAULT_PASSWORD),
    };
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
  try {
    const raw = fs.readFileSync(AUTH_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    return {
      cookieSecret:
        parsed.cookieSecret ?? crypto.randomBytes(32).toString('hex'),
      passwordHash: parsed.passwordHash ?? sha256(DEFAULT_PASSWORD),
    };
  } catch {
    fs.rmSync(AUTH_STATE_FILE, { force: true });
    return loadAuthState();
  }
}

/**
 * Back-compat alias — auth.ts still imports `loadState` from this module.
 * Returns just the auth-scoped fields; callers only read cookieSecret and
 * passwordHash.
 */
export function loadState(): AuthState {
  return loadAuthState();
}

// ---------------------------------------------------------------------------
// Draft state — per draft
// ---------------------------------------------------------------------------

export type TraceLevel = 'minimal' | 'summary' | 'full';

export interface DraftState {
  dirty: boolean;
  lastSyncedTargetHash: string | null;
  traceLevel: TraceLevel;
}

function defaultDraftState(): DraftState {
  return {
    dirty: false,
    lastSyncedTargetHash: null,
    traceLevel: 'summary',
  };
}

export function loadDraftState(draftName: string): DraftState {
  const paths = getDraftPaths(draftName);
  fs.mkdirSync(paths.metaDir, { recursive: true });
  if (!fs.existsSync(paths.stateFile)) {
    const fresh = defaultDraftState();
    saveDraftState(draftName, fresh);
    return fresh;
  }
  try {
    const raw = fs.readFileSync(paths.stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    return {
      dirty: parsed.dirty ?? false,
      lastSyncedTargetHash: parsed.lastSyncedTargetHash ?? null,
      traceLevel: (parsed.traceLevel as TraceLevel) ?? 'summary',
    };
  } catch {
    fs.rmSync(paths.stateFile, { force: true });
    return loadDraftState(draftName);
  }
}

export function saveDraftState(draftName: string, state: DraftState): void {
  const paths = getDraftPaths(draftName);
  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2));
}

export function updateDraftState(
  draftName: string,
  patch: Partial<DraftState>,
): DraftState {
  const next = { ...loadDraftState(draftName), ...patch };
  saveDraftState(draftName, next);
  return next;
}
