/**
 * Persona library browser — loads persona markdown files from
 * github.com/msitarzewski/agency-agents.
 *
 * Each file has YAML frontmatter (name, description, emoji, vibe, color)
 * followed by a markdown body that IS the persona. Loading a persona
 * copies its full text into the draft persona, marking the draft dirty.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { writeDraftPersona } from './draft.js';
import { PLAYGROUND_DIR } from './paths.js';

const REPO = 'https://github.com/msitarzewski/agency-agents.git';
const CACHE_DIR = path.join(PLAYGROUND_DIR, 'personas-cache');

// Top-level dirs that aren't persona categories.
const SKIP_DIRS = new Set(['.git', '.github', 'scripts', 'examples']);

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PersonaEntry {
  category: string;
  name: string;      // file basename without .md
  title: string;     // from frontmatter `name` if present
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
      const res = spawnSync('git', ['-C', CACHE_DIR, 'pull', '--ff-only'], { encoding: 'utf-8' });
      if (res.status !== 0) {
        logger.warn({ stderr: res.stderr }, 'Persona library refresh failed (continuing with cache)');
      }
    }
    return;
  }
  const res = spawnSync('git', ['clone', '--depth', '1', REPO, CACHE_DIR], { encoding: 'utf-8' });
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
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name') out.name = value;
    else if (key === 'description') out.description = value;
    else if (key === 'emoji') out.emoji = value;
  }
  return out;
}

export function listPersonas(refresh = false): PersonaEntry[] {
  try {
    ensureClone(refresh);
  } catch (err) {
    logger.warn({ err }, 'Persona library unavailable');
    return [];
  }

  const out: PersonaEntry[] = [];
  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const catDir = path.join(CACHE_DIR, entry.name);
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith('.md')) continue;
      const full = path.join(catDir, file);
      try {
        const md = fs.readFileSync(full, 'utf-8');
        const fm = parseFrontmatter(md);
        out.push({
          category: entry.name,
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
  return out.sort((a, b) =>
    a.category === b.category
      ? a.title.localeCompare(b.title)
      : a.category.localeCompare(b.category),
  );
}

function resolvePersonaFile(category: string, name: string): string | null {
  if (!SAFE_SEGMENT.test(category) || !SAFE_SEGMENT.test(name)) return null;
  const p = path.join(CACHE_DIR, category, `${name}.md`);
  // Guard against path escape even with regex above.
  const rel = path.relative(CACHE_DIR, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(p)) return null;
  return p;
}

export function previewPersona(category: string, name: string): PersonaPreview | null {
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
export function loadPersonaIntoDraft(category: string, name: string): void {
  const file = resolvePersonaFile(category, name);
  if (!file) throw new Error(`Persona not found: ${category}/${name}`);
  const content = fs.readFileSync(file, 'utf-8');
  writeDraftPersona(content);
}
