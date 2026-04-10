/**
 * Filesystem layout constants for the Agent Playground.
 *
 * Draft group folder: groups/draft/   (because runContainerAgent resolves
 *   folder names under GROUPS_DIR). CLAUDE.md in there IS the draft persona.
 *
 * Playground metadata: .nanoclaw/playground/  (ignored by git)
 *   draft/state.json          — dirty flag, last-synced hash, trace level
 *   draft/skills/<name>/      — editable / newly-authored skills (overlay)
 *   draft/workspace/attachments/ — file drops for the next message
 *   draft/sessions/<id>/events.jsonl  — per-session structured trace
 *   library-cache/            — git clone of anthropics/skills
 */
import path from 'path';

import { GROUPS_DIR, PROJECT_ROOT } from '../config.js';

export const PLAYGROUND_DIR = path.join(PROJECT_ROOT, '.nanoclaw', 'playground');
export const DRAFT_META_DIR = path.join(PLAYGROUND_DIR, 'draft');
export const DRAFT_SKILLS_DIR = path.join(DRAFT_META_DIR, 'skills');
export const DRAFT_WORKSPACE_DIR = path.join(DRAFT_META_DIR, 'workspace');
export const DRAFT_ATTACHMENTS_DIR = path.join(DRAFT_WORKSPACE_DIR, 'attachments');
export const DRAFT_SESSIONS_DIR = path.join(DRAFT_META_DIR, 'sessions');
export const DRAFT_STATE_FILE = path.join(DRAFT_META_DIR, 'state.json');

export const LIBRARY_CACHE_DIR = path.join(PLAYGROUND_DIR, 'library-cache');

export const DRAFT_GROUP_FOLDER = 'draft';
export const DRAFT_GROUP_DIR = path.join(GROUPS_DIR, DRAFT_GROUP_FOLDER);
export const DRAFT_PERSONA_FILE = path.join(DRAFT_GROUP_DIR, 'CLAUDE.md');

export const CONTAINER_SKILLS_DIR = path.join(PROJECT_ROOT, 'container', 'skills');
