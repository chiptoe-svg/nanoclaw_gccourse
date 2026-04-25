/**
 * Multi-source skill library registry.
 *
 * Sources are git repositories (or local directories) that contain
 * "skills" — any folder that has a SKILL.md file in it. Sources live in
 * a JSON file and clone on demand. The default source (Anthropic skills)
 * is seeded on first use.
 *
 * Layout:
 *   .nanoclaw/playground/skill-sources.json        — registry
 *   .nanoclaw/playground/skill-sources/<id>/       — clone / working tree
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { PLAYGROUND_DIR } from './paths.js';

const REGISTRY_FILE = path.join(PLAYGROUND_DIR, 'skill-sources.json');
const SOURCES_ROOT = path.join(PLAYGROUND_DIR, 'skill-sources');

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SkillSource {
  id: string;
  name: string;
  repo: string;
  /** Optional subdirectory within the repo where skills live. */
  path?: string;
}

export interface SkillFolderEntry {
  name: string; // skill folder name (== the skill's identifier)
  description: string; // from SKILL.md frontmatter
  files: SkillFileEntry[]; // contents of the skill folder
}

export interface SkillFileEntry {
  path: string; // relative to the skill folder
  size: number;
  isDir: boolean;
}

export interface SourceListing {
  source: SkillSource;
  skills: SkillFolderEntry[];
  error?: string;
}

const DEFAULT_SOURCES: SkillSource[] = [
  {
    id: 'anthropic',
    name: 'Anthropic skills',
    repo: 'https://github.com/anthropics/skills.git',
  },
];

function loadRegistry(): SkillSource[] {
  fs.mkdirSync(PLAYGROUND_DIR, { recursive: true });
  if (!fs.existsSync(REGISTRY_FILE)) {
    saveRegistry(DEFAULT_SOURCES);
    return DEFAULT_SOURCES.slice();
  }
  try {
    const raw = fs.readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('registry not an array');
    return parsed.filter(
      (s): s is SkillSource =>
        s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.repo === 'string',
    );
  } catch (err) {
    logger.warn({ err }, 'Skill source registry corrupt, reseeding');
    saveRegistry(DEFAULT_SOURCES);
    return DEFAULT_SOURCES.slice();
  }
}

function saveRegistry(sources: SkillSource[]): void {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(sources, null, 2));
}

function sourceCloneDir(source: SkillSource): string {
  return path.join(SOURCES_ROOT, source.id);
}

function sourceSkillsRoot(source: SkillSource): string {
  return source.path
    ? path.join(sourceCloneDir(source), source.path)
    : sourceCloneDir(source);
}

function ensureCloned(source: SkillSource, refresh = false): void {
  const dir = sourceCloneDir(source);
  fs.mkdirSync(SOURCES_ROOT, { recursive: true });
  const gitDir = path.join(dir, '.git');
  if (fs.existsSync(gitDir)) {
    if (refresh) {
      const res = spawnSync('git', ['-C', dir, 'pull', '--ff-only'], {
        encoding: 'utf-8',
      });
      if (res.status !== 0) {
        logger.warn(
          { id: source.id, stderr: res.stderr },
          'Source refresh failed',
        );
      }
    }
    return;
  }
  const res = spawnSync('git', ['clone', '--depth', '1', source.repo, dir], {
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    throw new Error(`Clone failed: ${res.stderr}`);
  }
}

/**
 * Walk a source's skills root and return every folder that contains a
 * SKILL.md, along with a listing of files inside that folder.
 */
function walkSource(source: SkillSource): SkillFolderEntry[] {
  const root = sourceSkillsRoot(source);
  if (!fs.existsSync(root)) return [];
  const results: SkillFolderEntry[] = [];

  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const hasSkillMd = entries.some((e) => e.isFile() && e.name === 'SKILL.md');
    if (hasSkillMd) {
      // This directory IS a skill folder. Record it and stop recursing
      // (nested skills inside a skill folder aren't a thing).
      const name = path.basename(dir);
      const skillMd = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
      const description = parseDescription(skillMd);
      const files = listSkillFolderFiles(dir);
      results.push({ name, description, files });
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory()) continue;
      visit(path.join(dir, e.name));
    }
  };
  visit(root);
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function listSkillFolderFiles(skillDir: string): SkillFileEntry[] {
  const files: SkillFileEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        files.push({ path: subRel, size: 0, isDir: true });
        walk(abs, subRel);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(abs);
          files.push({ path: subRel, size: stat.size, isDir: false });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(skillDir, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function parseDescription(skillMd: string): string {
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const desc = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (desc) return desc[1].trim();
  }
  const lines = skillMd.split('\n').map((l) => l.trim());
  for (const line of lines) {
    if (line.startsWith('#') || !line) continue;
    return line.slice(0, 160);
  }
  return '';
}

/**
 * Walk every source, cloning on demand. Sources that fail to clone are
 * returned with an error field instead of bubbling the failure out.
 */
export function listAllSources(refresh = false): SourceListing[] {
  const sources = loadRegistry();
  const out: SourceListing[] = [];
  for (const source of sources) {
    try {
      ensureCloned(source, refresh);
      const skills = walkSource(source);
      out.push({ source, skills });
    } catch (err) {
      out.push({
        source,
        skills: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function addSource(input: {
  name: string;
  repo: string;
  path?: string;
  id?: string;
}): SkillSource {
  if (!input.name || !input.repo) throw new Error('name and repo are required');
  const sources = loadRegistry();

  let id = input.id || slugify(input.name);
  if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
  // Ensure uniqueness
  const existingIds = new Set(sources.map((s) => s.id));
  if (existingIds.has(id)) {
    let suffix = 2;
    while (existingIds.has(`${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }

  const source: SkillSource = {
    id,
    name: input.name,
    repo: input.repo.trim(),
    path: input.path?.trim() || undefined,
  };
  sources.push(source);
  saveRegistry(sources);
  // Clone eagerly so validation errors surface now.
  try {
    ensureCloned(source);
  } catch (err) {
    // Roll back on clone failure.
    saveRegistry(sources.filter((s) => s.id !== id));
    throw err;
  }
  return source;
}

export function removeSource(id: string): void {
  if (id === 'anthropic') throw new Error('cannot remove the default source');
  const sources = loadRegistry();
  if (!sources.some((s) => s.id === id))
    throw new Error(`unknown source: ${id}`);
  saveRegistry(sources.filter((s) => s.id !== id));
  const dir = path.join(SOURCES_ROOT, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Resolve and read a specific file inside a skill folder. Strictly
 * path-confined to the skill folder (no ".." escapes, no absolute paths).
 */
export function readSourceFile(
  sourceId: string,
  skillName: string,
  filePath: string,
): { content: string; size: number } | null {
  if (!ID_PATTERN.test(sourceId)) return null;
  if (!SAFE_SEGMENT.test(skillName)) return null;

  const sources = loadRegistry();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) return null;

  // Find the actual skill folder (may be nested under source.path or a
  // category subdirectory).
  const skillDir = findSkillDir(source, skillName);
  if (!skillDir) return null;

  const abs = path.resolve(skillDir, filePath);
  const rel = path.relative(skillDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const stat = fs.statSync(abs);
  // Cap at 512KB to keep the UI snappy.
  if (stat.size > 512 * 1024) {
    return {
      content: `(file too large — ${stat.size} bytes)`,
      size: stat.size,
    };
  }
  return { content: fs.readFileSync(abs, 'utf-8'), size: stat.size };
}

function findSkillDir(source: SkillSource, skillName: string): string | null {
  const root = sourceSkillsRoot(source);
  if (!fs.existsSync(root)) return null;
  let found: string | null = null;
  const walk = (dir: string) => {
    if (found) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      if (path.basename(dir) === skillName) {
        found = dir;
      }
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (!e.isDirectory()) continue;
      walk(path.join(dir, e.name));
    }
  };
  walk(root);
  return found;
}

/**
 * Import a skill from a source into draft/skills/<name>/ (copy all files).
 */
export function importSourceSkill(
  sourceId: string,
  skillName: string,
  overwrite: boolean,
  draftSkillsDir: string,
): void {
  if (!ID_PATTERN.test(sourceId)) throw new Error('invalid source id');
  if (!SAFE_SEGMENT.test(skillName)) throw new Error('invalid skill name');
  const sources = loadRegistry();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`unknown source: ${sourceId}`);
  const skillDir = findSkillDir(source, skillName);
  if (!skillDir) throw new Error(`skill not found: ${skillName}`);

  const dst = path.join(draftSkillsDir, skillName);
  if (fs.existsSync(dst)) {
    if (!overwrite) throw new Error('skill already exists in draft');
    fs.rmSync(dst, { recursive: true, force: true });
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(skillDir, dst, { recursive: true });
}
