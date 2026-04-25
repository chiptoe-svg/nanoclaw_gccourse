/**
 * Persona library browser — loads persona markdown files from:
 *   1. A local `personas/` directory in the project root (shipped with the repo)
 *   2. github.com/msitarzewski/agency-agents (cloned on demand)
 *
 * Each file has YAML frontmatter (name, description, emoji, vibe, color)
 * followed by a markdown body that IS the persona. Loading a persona
 * copies its full text into the draft persona, marking the draft dirty.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import { writeDraftPersona } from './draft.js';
import { PLAYGROUND_DIR } from './paths.js';

const REPO = 'https://github.com/msitarzewski/agency-agents.git';
const CACHE_DIR = path.join(PLAYGROUND_DIR, 'personas-cache');
const LOCAL_PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');

// Top-level dirs that aren't persona categories.
const SKIP_DIRS = new Set(['.git', '.github', 'scripts', 'examples']);

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PersonaEntry {
  category: string;
  name: string; // file basename without .md
  title: string; // from frontmatter `name` if present
  description: string;
  emoji: string;
}

export interface PersonaPreview extends PersonaEntry {
  content: string;
}

function ensureClone(refresh = false): void {
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  const gitDir = path.join(CACHE_DIR, '.git');
  if (fs.existsSync(gitDir)) {
    if (refresh) {
      const res = spawnSync('git', ['-C', CACHE_DIR, 'pull', '--ff-only'], {
        encoding: 'utf-8',
      });
      if (res.status !== 0) {
        logger.warn(
          { stderr: res.stderr },
          'Persona library refresh failed (continuing with cache)',
        );
      }
    }
    return;
  }
  const res = spawnSync('git', ['clone', '--depth', '1', REPO, CACHE_DIR], {
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    throw new Error(`Persona library clone failed: ${res.stderr}`);
  }
}

interface Frontmatter {
  name?: string;
  description?: string;
  emoji?: string;
}

function parseFrontmatter(md: string): Frontmatter {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Frontmatter = {};
  for (const line of m[1].split('\n')) {
    const eq = line.indexOf(':');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'emoji') out.emoji = value;
  }
  return out;
}

function scanPersonaDir(
  dir: string,
  category: string,
  out: PersonaEntry[],
): void {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const full = path.join(dir, file);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const md = fs.readFileSync(full, 'utf-8');
      const fm = parseFrontmatter(md);
      out.push({
        category,
        name: file.replace(/\.md$/, ''),
        title: fm.name || file.replace(/\.md$/, ''),
        description: fm.description || '',
        emoji: fm.emoji || '',
      });
    } catch {
      /* skip unreadable */
    }
  }
}

export function listPersonas(refresh = false): PersonaEntry[] {
  const out: PersonaEntry[] = [];

  // 1. Local personas/ directory in the project root (shipped with the repo).
  //    Files directly inside are listed under category "nanoclaw".
  //    Subdirectories are treated as categories.
  if (fs.existsSync(LOCAL_PERSONAS_DIR)) {
    scanPersonaDir(LOCAL_PERSONAS_DIR, 'nanoclaw', out);
    for (const entry of fs.readdirSync(LOCAL_PERSONAS_DIR, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      scanPersonaDir(
        path.join(LOCAL_PERSONAS_DIR, entry.name),
        entry.name,
        out,
      );
    }
  }

  // 2. Agency-agents git repo (cloned on demand).
  try {
    ensureClone(refresh);
    for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      scanPersonaDir(path.join(CACHE_DIR, entry.name), entry.name, out);
    }
  } catch (err) {
    logger.warn({ err }, 'Persona library unavailable');
  }

  return out.sort((a, b) =>
    a.category === b.category
      ? a.title.localeCompare(b.title)
      : a.category.localeCompare(b.category),
  );
}

function resolvePersonaFile(category: string, name: string): string | null {
  if (!SAFE_SEGMENT.test(category) || !SAFE_SEGMENT.test(name)) return null;

  // Check local personas/ first (flat files use category "nanoclaw").
  const localCandidates =
    category === 'nanoclaw'
      ? [path.join(LOCAL_PERSONAS_DIR, `${name}.md`)]
      : [path.join(LOCAL_PERSONAS_DIR, category, `${name}.md`)];
  for (const p of localCandidates) {
    const rel = path.relative(LOCAL_PERSONAS_DIR, p);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(p)) {
      return p;
    }
  }

  // Fall back to the cloned agency-agents repo.
  const p = path.join(CACHE_DIR, category, `${name}.md`);
  const rel = path.relative(CACHE_DIR, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(p)) return null;
  return p;
}

export function previewPersona(
  category: string,
  name: string,
): PersonaPreview | null {
  const file = resolvePersonaFile(category, name);
  if (!file) return null;
  const content = fs.readFileSync(file, 'utf-8');
  const fm = parseFrontmatter(content);
  return {
    category,
    name,
    title: fm.name || name,
    description: fm.description || '',
    emoji: fm.emoji || '',
    content,
  };
}

/**
 * Load a persona into the draft, overwriting the current persona. The
 * entire file (frontmatter + body) is written so nothing is lost — the
 * draft persona is free-form markdown.
 */
export function loadPersonaIntoDraft(
  draftName: string,
  category: string,
  name: string,
): void {
  const file = resolvePersonaFile(category, name);
  if (!file) throw new Error(`Persona not found: ${category}/${name}`);
  const content = fs.readFileSync(file, 'utf-8');
  writeDraftPersona(draftName, content);
}
