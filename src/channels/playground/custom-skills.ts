/**
 * Per-agent custom skills.
 *
 * The Skills tab's editor saves named custom skills here. Unlike the
 * shared built-in (`container/skills/*`) and Anthropic-library skills,
 * a custom skill belongs to one agent group and is stored under its
 * group folder at `groups/<folder>/custom-skills/<name>/SKILL.md`.
 *
 * The group folder is mounted into the container at `/workspace/agent`,
 * so a custom skill is reachable in-container at
 * `/workspace/agent/custom-skills/<name>` — `syncSkillSymlinks`
 * (container-runner.ts) points `.claude-shared/skills/<name>` there
 * instead of the shared `/app/skills/<name>` when a custom copy exists.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

/** Same validator the skill-library browser uses — no traversal, no dotfiles. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface CustomSkillEntry {
  name: string;
  description: string;
}

function customSkillsRoot(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'custom-skills');
}

/** Best-effort `description:` from SKILL.md frontmatter. */
function parseDescription(md: string): string {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return '';
  for (const line of fm[1]!.split('\n')) {
    const m = line.match(/^description:\s*(.+)$/);
    if (m) return m[1]!.trim();
  }
  return '';
}

export function listCustomSkills(folder: string): CustomSkillEntry[] {
  const root = customSkillsRoot(folder);
  if (!fs.existsSync(root)) return [];
  const out: CustomSkillEntry[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillMd = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    out.push({ name: entry.name, description: parseDescription(fs.readFileSync(skillMd, 'utf-8')) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readCustomSkill(folder: string, name: string): string | undefined {
  if (!NAME_RE.test(name)) return undefined;
  const skillMd = path.join(customSkillsRoot(folder), name, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return undefined;
  try {
    return fs.readFileSync(skillMd, 'utf-8');
  } catch {
    return undefined;
  }
}

export function customSkillExists(folder: string, name: string): boolean {
  return NAME_RE.test(name) && fs.existsSync(path.join(customSkillsRoot(folder), name, 'SKILL.md'));
}

/** Create or overwrite a custom skill's SKILL.md. Throws on an invalid name. */
export function writeCustomSkill(folder: string, name: string, content: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error('skill name must be alphanumeric (dashes, dots, underscores allowed)');
  }
  const dir = path.join(customSkillsRoot(folder), name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

/** Delete a custom skill. Returns false when the name is invalid or absent. */
export function deleteCustomSkill(folder: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const dir = path.join(customSkillsRoot(folder), name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
