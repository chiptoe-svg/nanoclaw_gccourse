/**
 * Active-draft session manager.
 *
 * At most one draft is "active" in the playground at a time. Picking a
 * draft starts a session: the draft's persona + skills overlay are
 * snapshotted so the user can cancel. All other playground routes refuse
 * to act unless a session is active. Saving applies the draft to its
 * target group. Cancelling restores the snapshot. Either way, the session
 * ends and the picker becomes available again.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { applyDraft, ensureDraftInitialized } from './draft.js';
import {
  getDraftPaths,
  isValidDraftName,
  listDrafts,
  DraftEntry,
} from './paths.js';
import { resetRunSingletons } from './run.js';
import { startTraceWatcher, stopTraceWatcher } from './trace.js';

let activeDraft: string | null = null;

export function getActiveDraft(): string | null {
  return activeDraft;
}

/**
 * Throw unless a session is active. Used as a guard by the API layer.
 */
export function requireActiveDraft(): string {
  if (!activeDraft) {
    const err = new Error('no_active_draft') as Error & { code: string };
    err.code = 'no_active_draft';
    throw err;
  }
  return activeDraft;
}

export function listAvailableDrafts(): DraftEntry[] {
  return listDrafts();
}

function snapshotDraft(draftName: string): void {
  const paths = getDraftPaths(draftName);
  fs.rmSync(paths.backupDir, { recursive: true, force: true });
  fs.mkdirSync(paths.backupDir, { recursive: true });
  if (fs.existsSync(paths.personaFile)) {
    fs.copyFileSync(paths.personaFile, path.join(paths.backupDir, 'CLAUDE.md'));
  }
  if (fs.existsSync(paths.skillsDir)) {
    fs.cpSync(paths.skillsDir, path.join(paths.backupDir, 'skills'), {
      recursive: true,
    });
  }
}

function restoreFromSnapshot(draftName: string): void {
  const paths = getDraftPaths(draftName);
  const backedPersona = path.join(paths.backupDir, 'CLAUDE.md');
  const backedSkills = path.join(paths.backupDir, 'skills');

  if (fs.existsSync(backedPersona)) {
    fs.copyFileSync(backedPersona, paths.personaFile);
  } else if (fs.existsSync(paths.personaFile)) {
    fs.rmSync(paths.personaFile);
  }

  fs.rmSync(paths.skillsDir, { recursive: true, force: true });
  if (fs.existsSync(backedSkills)) {
    fs.cpSync(backedSkills, paths.skillsDir, { recursive: true });
  } else {
    fs.mkdirSync(paths.skillsDir, { recursive: true });
  }
}

function clearSnapshot(draftName: string): void {
  const paths = getDraftPaths(draftName);
  fs.rmSync(paths.backupDir, { recursive: true, force: true });
}

export type StartResult =
  | { ok: true; draftName: string }
  | {
      ok: false;
      error:
        | 'session_already_active'
        | 'invalid_draft_name'
        | 'draft_not_found';
    };

export function startDraftSession(draftName: string): StartResult {
  if (activeDraft) {
    if (activeDraft === draftName) return { ok: true, draftName };
    return { ok: false, error: 'session_already_active' };
  }
  if (!isValidDraftName(draftName)) {
    return { ok: false, error: 'invalid_draft_name' };
  }
  const entry = listDrafts().find((d) => d.name === draftName);
  if (!entry) {
    return { ok: false, error: 'draft_not_found' };
  }

  ensureDraftInitialized(draftName);
  snapshotDraft(draftName);

  activeDraft = draftName;
  resetRunSingletons();
  startTraceWatcher(draftName);

  logger.info({ draftName }, 'Playground draft session started');
  return { ok: true, draftName };
}

export type EndResult =
  | {
      ok: true;
      action: 'save' | 'cancel';
      applied?: {
        backupPath: string;
        skillsPromoted: string[];
        targetFolder: string;
      };
    }
  | { ok: false; error: string };

export function endDraftSession(action: 'save' | 'cancel'): EndResult {
  if (!activeDraft) return { ok: false, error: 'no_active_draft' };
  const draftName = activeDraft;

  let applied;
  try {
    if (action === 'save') {
      applied = applyDraft(draftName);
    } else {
      restoreFromSnapshot(draftName);
    }
    clearSnapshot(draftName);
  } catch (err) {
    logger.error(
      { err, draftName, action },
      'Failed to end playground session',
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  stopTraceWatcher();
  resetRunSingletons();
  activeDraft = null;
  logger.info({ draftName, action }, 'Playground draft session ended');
  return { ok: true, action, applied };
}
