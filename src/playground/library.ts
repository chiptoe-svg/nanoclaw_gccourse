/**
 * Anthropic skills library browser.
 *
 * On first use, shallow-clones github.com/anthropics/skills into
 * .nanoclaw/playground/library-cache/. Subsequent calls re-use the cache
 * (and git-pull on explicit refresh).
 *
 * Compatibility check: parses SKILL.md for references to tools that
 * NanoClaw containers don't offer (artifacts, computer_use, etc.) and
 * emits a badge.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { DRAFT_SKILLS_DIR, LIBRARY_CACHE_DIR } from './paths.js';
import { isValidSkillName } from './skills.js';

const LIBRARY_REPO = 'https://github.com/anthropics/skills.git';

// Tools available inside NanoClaw containers (subset of agent-runner allowedTools).
const NANOCLAW_TOOLS = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'websearch',
  'webfetch',
  'task',
  'taskoutput',
  'taskstop',
  'teamcreate',
  'teamdelete',
  'sendmessage',
  'todowrite',
  'toolsearch',
  'skill',
  'notebookedit',
]);

// Tools known to be incompatible (document the common ones).
const KNOWN_INCOMPATIBLE = new Set([
  'artifacts',
  'computer_use',
  'computer',
  'str_replace_editor',
]);

export interface LibraryEntry {
  category: string;
  name: string;
  description: string;
}

export interface LibraryPreview {
  category: string;
  name: string;
  content: string;
  compatibility: 'compatible' | 'partial' | 'incompatible';
  missing: string[];
  incompatible: string[];
}

function ensureClone(refresh = false): void {
  fs.mkdirSync(path.dirname(LIBRARY_CACHE_DIR), { recursive: true });
  const gitDir = path.join(LIBRARY_CACHE_DIR, '.git');
  if (fs.existsSync(gitDir)) {
    if (refresh) {
      const res = spawnSync('git', ['-C', LIBRARY_CACHE_DIR, 'pull', '--ff-only'], {
        encoding: 'utf-8',
      });
      if (res.status !== 0) {
        logger.warn({ stderr: res.stderr }, 'Library refresh failed (continuing with cache)');
      }
    }
    return;
  }
  const res = spawnSync(
    'git',
    ['clone', '--depth', '1', LIBRARY_REPO, LIBRARY_CACHE_DIR],
    { encoding: 'utf-8' },
  );
  if (res.status !== 0) {
    throw new Error(`Library clone failed: ${res.stderr}`);
  }
}

function parseDescription(md: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const desc = fm[1].match(/^description:\s*(.+)$/m);
    if (desc) return desc[1].trim();
  }
  return '';
}

/**
 * Walk the cache, find every SKILL.md. The library groups skills under
 * category subdirectories at top level (e.g. skills/document-creation/pptx/).
 * We treat the first segment as category and the last containing-dir as name.
 */
export function listLibrary(refresh = false): LibraryEntry[] {
  try {
    ensureClone(refresh);
  } catch (err) {
    logger.warn({ err }, 'Library clone unavailable');
    return [];
  }
  const out: LibraryEntry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, subRel);
      } else if (entry.name === 'SKILL.md') {
        const parts = subRel.split('/');
        // parts = [category, ..., name, 'SKILL.md']
        if (parts.length < 2) continue;
        const name = parts[parts.length - 2];
        const category = parts[0];
        const md = fs.readFileSync(full, 'utf-8');
        out.push({ category, name, description: parseDescription(md) });
      }
    }
  };
  walk(LIBRARY_CACHE_DIR, '');
  return out.sort((a, b) =>
    a.category === b.category
      ? a.name.localeCompare(b.name)
      : a.category.localeCompare(b.category),
  );
}

function findLibrarySkillDir(category: string, name: string): string | null {
  // Walk to find a dir that ends in /<category>/.../<name>/SKILL.md.
  // We only trust alphanumeric + - + _ segments.
  const SAFE = /^[A-Za-z0-9_-]+$/;
  if (!SAFE.test(category) || !SAFE.test(name)) return null;

  let found: string | null = null;
  const walk = (dir: string, rel: string) => {
    if (found) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (found) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      const subRel = rel ? `${rel}/${entry.name}` : entry.name;
      const parts = subRel.split('/');
      if (entry.name === name && parts[0] === category) {
        if (fs.existsSync(path.join(full, 'SKILL.md'))) {
          found = full;
          return;
        }
      }
      walk(full, subRel);
    }
  };
  walk(LIBRARY_CACHE_DIR, '');
  return found;
}

/**
 * Compatibility check — only looks at EXPLICIT tool declarations in the
 * YAML frontmatter. Fields considered: `allowed-tools`, `tools`.
 *
 * Previous version did a substring match against the whole SKILL.md
 * (including prose description) which false-positived aggressively:
 * "frontend-design" mentions "artifacts, posters, or applications" as
 * examples of what it builds, which has nothing to do with the Anthropic
 * `artifacts` tool. We now default to "compatible" unless a declared
 * tool is on the incompatible list.
 */
function checkCompatibility(content: string): Pick<LibraryPreview, 'compatibility' | 'missing' | 'incompatible'> {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { compatibility: 'compatible', missing: [], incompatible: [] };
  }
  const frontmatter = fmMatch[1];

  // Look for `allowed-tools:` or `tools:` at the start of a line.
  // Value can be inline (`tools: Bash, Read`) or a YAML list on subsequent
  // lines (`tools:\n  - Bash\n  - Read`).
  const declared: string[] = [];
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(?:allowed-tools|tools):\s*(.*)$/i);
    if (!m) continue;
    if (m[1].trim()) {
      // Inline form
      for (const piece of m[1].split(',')) {
        const clean = piece.trim().replace(/^[[\]"']|[[\]"']$/g, '');
        if (clean) declared.push(clean);
      }
    } else {
      // YAML list — consume subsequent "  - Name" lines
      for (let j = i + 1; j < lines.length; j++) {
        const item = lines[j].match(/^\s*-\s*(.+)$/);
        if (!item) break;
        declared.push(item[1].trim());
      }
    }
  }

  if (declared.length === 0) {
    return { compatibility: 'compatible', missing: [], incompatible: [] };
  }

  const incompatible: string[] = [];
  const missing: string[] = [];
  for (const raw of declared) {
    const lower = raw.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!lower) continue;
    if (KNOWN_INCOMPATIBLE.has(lower)) {
      incompatible.push(raw);
    } else if (!NANOCLAW_TOOLS.has(lower)) {
      missing.push(raw);
    }
  }

  let compatibility: 'compatible' | 'partial' | 'incompatible' = 'compatible';
  if (incompatible.length > 0) compatibility = 'incompatible';
  else if (missing.length > 0) compatibility = 'partial';

  return { compatibility, missing, incompatible };
}

export function previewLibrarySkill(category: string, name: string): LibraryPreview | null {
  const dir = findLibrarySkillDir(category, name);
  if (!dir) return null;
  const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
  return {
    category,
    name,
    content,
    ...checkCompatibility(content),
  };
}

/**
 * Import a library skill into draft/skills/. Skill folder name is
 * taken directly from the library entry. Fails if the skill already
 * exists in draft/skills/ unless overwrite is set.
 */
export function importLibrarySkill(
  category: string,
  name: string,
  overwrite: boolean,
): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const src = findLibrarySkillDir(category, name);
  if (!src) throw new Error(`Library skill not found: ${category}/${name}`);
  const dst = path.join(DRAFT_SKILLS_DIR, name);
  if (fs.existsSync(dst)) {
    if (!overwrite) throw new Error(`Skill already exists in draft: ${name}`);
    fs.rmSync(dst, { recursive: true, force: true });
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
