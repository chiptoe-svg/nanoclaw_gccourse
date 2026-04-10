/**
 * Playground draft state file (state.json).
 *
 * Tracks whether the draft has local edits relative to main, the hash of
 * main's persona at the time of the last sync (for external-change
 * detection), the trace verbosity, and the HMAC secret used to sign session
 * cookies.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DRAFT_META_DIR, DRAFT_STATE_FILE } from './paths.js';

export type TraceLevel = 'minimal' | 'summary' | 'full';

export interface PlaygroundState {
  dirty: boolean;
  lastSyncedMainHash: string | null;
  traceLevel: TraceLevel;
  cookieSecret: string;
  // Password hash. sha256(password). Not great, but adequate for a shared
  // classroom password per plan.
  passwordHash: string;
}

const DEFAULT_PASSWORD = 'godfrey';

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function loadState(): PlaygroundState {
  fs.mkdirSync(DRAFT_META_DIR, { recursive: true });
  if (!fs.existsSync(DRAFT_STATE_FILE)) {
    const fresh: PlaygroundState = {
      dirty: false,
      lastSyncedMainHash: null,
      traceLevel: 'summary',
      cookieSecret: crypto.randomBytes(32).toString('hex'),
      passwordHash: sha256(DEFAULT_PASSWORD),
    };
    saveState(fresh);
    return fresh;
  }
  try {
    const raw = fs.readFileSync(DRAFT_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PlaygroundState>;
    return {
      dirty: parsed.dirty ?? false,
      lastSyncedMainHash: parsed.lastSyncedMainHash ?? null,
      traceLevel: (parsed.traceLevel as TraceLevel) ?? 'summary',
      cookieSecret: parsed.cookieSecret ?? crypto.randomBytes(32).toString('hex'),
      passwordHash: parsed.passwordHash ?? sha256(DEFAULT_PASSWORD),
    };
  } catch {
    // Corrupt file — rebuild from defaults.
    fs.rmSync(DRAFT_STATE_FILE, { force: true });
    return loadState();
  }
}

export function saveState(state: PlaygroundState): void {
  fs.mkdirSync(path.dirname(DRAFT_STATE_FILE), { recursive: true });
  fs.writeFileSync(DRAFT_STATE_FILE, JSON.stringify(state, null, 2));
}

export function updateState(patch: Partial<PlaygroundState>): PlaygroundState {
  const next = { ...loadState(), ...patch };
  saveState(next);
  return next;
}
