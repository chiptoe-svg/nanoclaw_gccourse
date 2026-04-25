/**
 * Draft lifecycle — per-draft persona read/write, initialization from the
 * target group, apply back to target, reset to target, diff.
 *
 * A draft named "draft_<target>" corresponds to the agent group at
 * groups/<target>/. Applying a draft writes its CLAUDE.md into the target
 * group's folder. Resetting copies the target's CLAUDE.md back into the
 * draft.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import {
  CONTAINER_SKILLS_DIR,
  getDraftPaths,
  isValidDraftName,
} from './paths.js';
import { loadDraftState, updateDraftState } from './state.js';

export interface DraftStatus {
  draftName: string;
  targetFolder: string;
  persona: string;
  targetPersona: string;
  dirty: boolean;
  externalChange: boolean;
  traceLevel: string;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function targetPersonaPath(targetFolder: string): string {
  return path.join(GROUPS_DIR, targetFolder, 'CLAUDE.md');
}

export function readTargetPersona(targetFolder: string): string {
  const p = targetPersonaPath(targetFolder);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf-8');
}

export function readDraftPersona(draftName: string): string {
  const { personaFile } = getDraftPaths(draftName);
  if (!fs.existsSync(personaFile)) return '';
  return fs.readFileSync(personaFile, 'utf-8');
}

/**
 * Ensure every playground directory for this draft exists, and seed the
 * draft persona from the target group if empty. Safe to call repeatedly.
 */
export function ensureDraftInitialized(draftName: string): void {
  const paths = getDraftPaths(draftName);
  fs.mkdirSync(paths.metaDir, { recursive: true });
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  fs.mkdirSync(paths.attachmentsDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.mkdirSync(paths.groupDir, { recursive: true });
  fs.mkdirSync(path.join(paths.groupDir, 'memory'), { recursive: true });

  if (!fs.existsSync(paths.personaFile)) {
    const target = readTargetPersona(paths.targetFolder);
    fs.writeFileSync(paths.personaFile, target);
    updateDraftState(draftName, {
      dirty: false,
      lastSyncedTargetHash: hashText(target),
    });
    logger.info(
      { draftName, targetFolder: paths.targetFolder },
      'Initialized draft persona from target',
    );
  }
}

/**
 * Seed the default draft_<targetFolder> if its target exists and the draft
 * doesn't. Idempotent — returns a list of drafts created this call.
 */
export function seedDraftFromTarget(targetFolder: string): string | null {
  const draftName = `draft_${targetFolder}`;
  if (!isValidDraftName(draftName)) return null;
  const paths = getDraftPaths(draftName);
  if (fs.existsSync(paths.personaFile)) return null;
  const targetPath = path.join(GROUPS_DIR, targetFolder);
  if (!fs.existsSync(targetPath)) return null;
  ensureDraftInitialized(draftName);
  return draftName;
}

export function getDraftStatus(draftName: string): DraftStatus {
  ensureDraftInitialized(draftName);
  const paths = getDraftPaths(draftName);
  const state = loadDraftState(draftName);
  const draft = readDraftPersona(draftName);
  const target = readTargetPersona(paths.targetFolder);
  const targetHash = hashText(target);

  const dirty = state.dirty || draft !== target;
  const externalChange =
    state.lastSyncedTargetHash !== null &&
    state.lastSyncedTargetHash !== targetHash;

  return {
    draftName,
    targetFolder: paths.targetFolder,
    persona: draft,
    targetPersona: target,
    dirty,
    externalChange,
    traceLevel: state.traceLevel,
  };
}

export function writeDraftPersona(draftName: string, text: string): void {
  ensureDraftInitialized(draftName);
  const { personaFile } = getDraftPaths(draftName);
  fs.writeFileSync(personaFile, text);
  updateDraftState(draftName, { dirty: true });
}

/**
 * Apply draft persona + skills overlay to the target group.
 *   - Back up target CLAUDE.md to groups/<target>/.history/CLAUDE-<ts>.md
 *   - Copy draft persona into target CLAUDE.md
 *   - Copy draft skills overlay into container/skills/ (additive, no backup)
 */
export function applyDraft(draftName: string): {
  backupPath: string;
  skillsPromoted: string[];
  targetFolder: string;
} {
  const paths = getDraftPaths(draftName);
  const targetDir = path.join(GROUPS_DIR, paths.targetFolder);
  if (!fs.existsSync(targetDir)) {
    throw new Error(`Target group missing: ${paths.targetFolder}`);
  }
  const targetPersona = path.join(targetDir, 'CLAUDE.md');

  const historyDir = path.join(targetDir, '.history');
  fs.mkdirSync(historyDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(historyDir, `CLAUDE-${ts}.md`);
  if (fs.existsSync(targetPersona)) {
    fs.copyFileSync(targetPersona, backupPath);
  }

  const draftText = readDraftPersona(draftName);
  fs.writeFileSync(targetPersona, draftText);

  fs.mkdirSync(CONTAINER_SKILLS_DIR, { recursive: true });
  const promoted: string[] = [];
  if (fs.existsSync(paths.skillsDir)) {
    for (const name of fs.readdirSync(paths.skillsDir)) {
      const src = path.join(paths.skillsDir, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const dst = path.join(CONTAINER_SKILLS_DIR, name);
      fs.cpSync(src, dst, { recursive: true });
      promoted.push(name);
    }
  }

  updateDraftState(draftName, {
    dirty: false,
    lastSyncedTargetHash: hashText(draftText),
  });
  logger.info(
    { draftName, backupPath, promoted, targetFolder: paths.targetFolder },
    'Applied draft to target',
  );
  return { backupPath, skillsPromoted: promoted, targetFolder: paths.targetFolder };
}

/**
 * Discard draft edits. Copy target CLAUDE.md back into the draft and wipe
 * the draft skills overlay. Archived sessions (trace history) are preserved.
 */
export function resetDraftFromTarget(draftName: string): void {
  ensureDraftInitialized(draftName);
  const paths = getDraftPaths(draftName);
  const target = readTargetPersona(paths.targetFolder);
  fs.writeFileSync(paths.personaFile, target);
  fs.rmSync(paths.skillsDir, { recursive: true, force: true });
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  updateDraftState(draftName, {
    dirty: false,
    lastSyncedTargetHash: hashText(target),
  });
  logger.info({ draftName }, 'Reset draft from target');
}

export function computePersonaDiff(draftName: string): {
  a: string;
  b: string;
  changed: boolean;
} {
  const paths = getDraftPaths(draftName);
  const draft = readDraftPersona(draftName);
  const target = readTargetPersona(paths.targetFolder);
  return { a: target, b: draft, changed: draft !== target };
}

// ---------------------------------------------------------------------------
// Global CLAUDE.md editor — unchanged (not per-draft; affects all groups)
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

export function writeGlobalClaude(
  content: string,
  knownHash: string,
):
  | { ok: true; backupPath: string | null; newHash: string }
  | { ok: false; conflict: string } {
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
