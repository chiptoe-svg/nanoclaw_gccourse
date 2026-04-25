/**
 * Filesystem layout for the Agent Playground.
 *
 * Drafts live at groups/draft_<target>/ where <target> is the name of the
 * real agent group the draft applies to. For example:
 *   groups/draft_telegram_main/ applies to groups/telegram_main/
 *   groups/draft_telegram_sandy/ applies to groups/telegram_sandy/
 *
 * Per-draft playground metadata sits alongside each draft:
 *   .nanoclaw/playground/<draft-name>/state.json
 *   .nanoclaw/playground/<draft-name>/skills/<name>/
 *   .nanoclaw/playground/<draft-name>/workspace/attachments/
 *   .nanoclaw/playground/<draft-name>/sessions/<id>/events.jsonl
 *   .nanoclaw/playground/<draft-name>/backup/           (for session cancel)
 *
 * Shared across drafts:
 *   .nanoclaw/playground/auth.json       (cookie secret + password hash)
 *   .nanoclaw/playground/library-cache/  (cloned skill/persona libraries)
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOT } from '../config.js';

export const PLAYGROUND_DIR = path.join(
  PROJECT_ROOT,
  '.nanoclaw',
  'playground',
);

export const LIBRARY_CACHE_DIR = path.join(PLAYGROUND_DIR, 'library-cache');
export const AUTH_STATE_FILE = path.join(PLAYGROUND_DIR, 'auth.json');

export const CONTAINER_SKILLS_DIR = path.join(
  PROJECT_ROOT,
  'container',
  'skills',
);

export const DRAFT_PREFIX = 'draft_';
const DRAFT_NAME_PATTERN = /^draft_[a-z0-9][a-z0-9_-]*$/;

export interface DraftPaths {
  draftName: string; // "draft_telegram_main"
  targetFolder: string; // "telegram_main"
  groupDir: string;
  personaFile: string;
  metaDir: string;
  skillsDir: string;
  workspaceDir: string;
  attachmentsDir: string;
  sessionsDir: string;
  stateFile: string;
  backupDir: string;
}

export function isValidDraftName(name: string): boolean {
  return DRAFT_NAME_PATTERN.test(name);
}

export function getDraftPaths(draftName: string): DraftPaths {
  if (!isValidDraftName(draftName)) {
    throw new Error(`Invalid draft name: ${draftName}`);
  }
  const targetFolder = draftName.slice(DRAFT_PREFIX.length);
  const groupDir = path.join(GROUPS_DIR, draftName);
  const metaDir = path.join(PLAYGROUND_DIR, draftName);
  return {
    draftName,
    targetFolder,
    groupDir,
    personaFile: path.join(groupDir, 'CLAUDE.md'),
    metaDir,
    skillsDir: path.join(metaDir, 'skills'),
    workspaceDir: path.join(metaDir, 'workspace'),
    attachmentsDir: path.join(metaDir, 'workspace', 'attachments'),
    sessionsDir: path.join(metaDir, 'sessions'),
    stateFile: path.join(metaDir, 'state.json'),
    backupDir: path.join(metaDir, 'backup'),
  };
}

export interface DraftEntry {
  name: string;
  target: string;
  hasPersona: boolean;
}

/**
 * List all drafts on disk whose target folder exists. Drafts whose target
 * is missing are omitted — the picker won't show them.
 */
export function listDrafts(): DraftEntry[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  const entries: DraftEntry[] = [];
  for (const dir of fs.readdirSync(GROUPS_DIR)) {
    if (!dir.startsWith(DRAFT_PREFIX)) continue;
    if (!isValidDraftName(dir)) continue;
    const full = path.join(GROUPS_DIR, dir);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const target = dir.slice(DRAFT_PREFIX.length);
    const targetPath = path.join(GROUPS_DIR, target);
    let targetIsDir = false;
    try {
      targetIsDir = fs.statSync(targetPath).isDirectory();
    } catch {
      /* target missing */
    }
    if (!targetIsDir) continue;
    const personaFile = path.join(full, 'CLAUDE.md');
    entries.push({
      name: dir,
      target,
      hasPersona: fs.existsSync(personaFile),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
