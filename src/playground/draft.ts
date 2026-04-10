/**
 * Draft lifecycle: initialize from main, read persona, save persona, apply
 * draft back to main, reset draft from main, hash-based external-change
 * detection.
 *
 * Draft "main" is whichever registered group has isMain=true. Its CLAUDE.md
 * is the source and target for persona edits. If no main is registered,
 * falls back to an empty draft persona.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { getAllRegisteredGroups } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import {
  CONTAINER_SKILLS_DIR,
  DRAFT_ATTACHMENTS_DIR,
  DRAFT_GROUP_DIR,
  DRAFT_META_DIR,
  DRAFT_PERSONA_FILE,
  DRAFT_SESSIONS_DIR,
  DRAFT_SKILLS_DIR,
  DRAFT_WORKSPACE_DIR,
} from './paths.js';
import { loadState, updateState } from './state.js';

export interface DraftStatus {
  persona: string;
  mainPersona: string;
  mainGroupName: string | null;
  mainGroupFolder: string | null;
  dirty: boolean;
  externalChange: boolean;
  traceLevel: string;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Find the registered group flagged is_main=1.
 * Throws if none found — the playground has nothing to edit otherwise.
 */
export function findMainGroup(): RegisteredGroup | null {
  const all = getAllRegisteredGroups();
  for (const g of Object.values(all)) {
    if (g.isMain) return g;
  }
  return null;
}

export function readMainPersona(): string {
  const main = findMainGroup();
  if (!main) return '';
  const mainDir = resolveGroupFolderPath(main.folder);
  const personaPath = path.join(mainDir, 'CLAUDE.md');
  if (!fs.existsSync(personaPath)) return '';
  return fs.readFileSync(personaPath, 'utf-8');
}

export function readDraftPersona(): string {
  if (!fs.existsSync(DRAFT_PERSONA_FILE)) return '';
  return fs.readFileSync(DRAFT_PERSONA_FILE, 'utf-8');
}

/**
 * Ensure every playground directory exists and the draft persona is
 * initialized (first-run). Safe to call repeatedly.
 */
export function ensureDraftInitialized(): void {
  fs.mkdirSync(DRAFT_META_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_SKILLS_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_ATTACHMENTS_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_GROUP_DIR, { recursive: true });
  // Memory scratch dir inside the draft group
  fs.mkdirSync(path.join(DRAFT_GROUP_DIR, 'memory'), { recursive: true });

  if (!fs.existsSync(DRAFT_PERSONA_FILE)) {
    const main = readMainPersona();
    fs.writeFileSync(DRAFT_PERSONA_FILE, main);
    updateState({
      dirty: false,
      lastSyncedMainHash: hashText(main),
    });
    logger.info('Initialized draft persona from main group');
  }
}

/**
 * Compare draft persona to main and report status for the UI.
 */
export function getDraftStatus(): DraftStatus {
  ensureDraftInitialized();
  const state = loadState();
  const draft = readDraftPersona();
  const main = readMainPersona();
  const mainGroup = findMainGroup();
  const mainHash = hashText(main);

  const dirty = state.dirty || draft !== main;
  const externalChange =
    state.lastSyncedMainHash !== null && state.lastSyncedMainHash !== mainHash;

  return {
    persona: draft,
    mainPersona: main,
    mainGroupName: mainGroup?.name ?? null,
    mainGroupFolder: mainGroup?.folder ?? null,
    dirty,
    externalChange,
    traceLevel: state.traceLevel,
  };
}

export function writeDraftPersona(text: string): void {
  ensureDraftInitialized();
  fs.writeFileSync(DRAFT_PERSONA_FILE, text);
  updateState({ dirty: true });
}

/**
 * Apply draft persona + skills to the live main group.
 *   - Back up current main CLAUDE.md to .history/CLAUDE-<ts>.md
 *   - Copy draft persona into main CLAUDE.md
 *   - Copy draft/skills/* into container/skills/* (merge, per plan; no
 *     backup because skills are additive).
 */
export function applyDraftToMain(): { backupPath: string; skillsPromoted: string[] } {
  const main = findMainGroup();
  if (!main) throw new Error('No main group registered');
  const mainDir = resolveGroupFolderPath(main.folder);
  const mainPersonaPath = path.join(mainDir, 'CLAUDE.md');

  // Backup
  const historyDir = path.join(mainDir, '.history');
  fs.mkdirSync(historyDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(historyDir, `CLAUDE-${ts}.md`);
  if (fs.existsSync(mainPersonaPath)) {
    fs.copyFileSync(mainPersonaPath, backupPath);
  }

  // Persona
  const draftText = readDraftPersona();
  fs.writeFileSync(mainPersonaPath, draftText);

  // Skills — promote each draft skill into container/skills/<name>/
  fs.mkdirSync(CONTAINER_SKILLS_DIR, { recursive: true });
  const promoted: string[] = [];
  if (fs.existsSync(DRAFT_SKILLS_DIR)) {
    for (const name of fs.readdirSync(DRAFT_SKILLS_DIR)) {
      const src = path.join(DRAFT_SKILLS_DIR, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const dst = path.join(CONTAINER_SKILLS_DIR, name);
      fs.cpSync(src, dst, { recursive: true });
      promoted.push(name);
    }
  }

  updateState({
    dirty: false,
    lastSyncedMainHash: hashText(draftText),
  });
  logger.info(
    { backupPath, promoted, mainGroup: main.folder },
    'Applied draft to main',
  );
  return { backupPath, skillsPromoted: promoted };
}

/**
 * Discard draft edits. Overwrites draft persona with main and wipes
 * draft/skills/. Does NOT wipe archived sessions (trace history is useful
 * even after a reset).
 */
export function resetDraftFromMain(): void {
  ensureDraftInitialized();
  const main = readMainPersona();
  fs.writeFileSync(DRAFT_PERSONA_FILE, main);
  fs.rmSync(DRAFT_SKILLS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DRAFT_SKILLS_DIR, { recursive: true });
  updateState({
    dirty: false,
    lastSyncedMainHash: hashText(main),
  });
  logger.info('Reset draft from main');
}

/**
 * Unified diff for UI display. Minimal implementation — shows changed
 * lines with a/b prefixes; a real patch format is overkill for the
 * single-file teaching use case.
 */
export function computePersonaDiff(): { a: string; b: string; changed: boolean } {
  const draft = readDraftPersona();
  const main = readMainPersona();
  return { a: main, b: draft, changed: draft !== main };
}

// ---------------------------------------------------------------------------
// Global CLAUDE.md editor
//
// groups/global/CLAUDE.md is loaded into every non-main group's container
// as additional system context. Editing it affects every agent — including
// the live main agent — so it needs the same "hash to detect external
// change" guard the draft persona has.
// ---------------------------------------------------------------------------

const GLOBAL_DIR = path.join(GROUPS_DIR, 'global');
const GLOBAL_CLAUDE_FILE = path.join(GLOBAL_DIR, 'CLAUDE.md');

export interface GlobalStatus {
  exists: boolean;
  content: string;
  hash: string;
}

export function getGlobalClaude(): GlobalStatus {
  if (!fs.existsSync(GLOBAL_CLAUDE_FILE)) {
    return { exists: false, content: '', hash: hashText('') };
  }
  const content = fs.readFileSync(GLOBAL_CLAUDE_FILE, 'utf-8');
  return { exists: true, content, hash: hashText(content) };
}

/**
 * Write global CLAUDE.md. `knownHash` is the hash the client saw when it
 * loaded the file; if it doesn't match the current on-disk hash, someone
 * else edited it externally and we refuse the write. Backs up the
 * previous contents to groups/global/.history/CLAUDE-<ts>.md.
 */
export function writeGlobalClaude(content: string, knownHash: string): {
  ok: true;
  backupPath: string | null;
  newHash: string;
} | { ok: false; conflict: string } {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  let backupPath: string | null = null;
  if (fs.existsSync(GLOBAL_CLAUDE_FILE)) {
    const current = fs.readFileSync(GLOBAL_CLAUDE_FILE, 'utf-8');
    const currentHash = hashText(current);
    if (knownHash && currentHash !== knownHash) {
      return { ok: false, conflict: currentHash };
    }
    const historyDir = path.join(GLOBAL_DIR, '.history');
    fs.mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(historyDir, `CLAUDE-${ts}.md`);
    fs.copyFileSync(GLOBAL_CLAUDE_FILE, backupPath);
  }
  fs.writeFileSync(GLOBAL_CLAUDE_FILE, content);
  logger.info({ backupPath }, 'Wrote groups/global/CLAUDE.md');
  return { ok: true, backupPath, newHash: hashText(content) };
}
