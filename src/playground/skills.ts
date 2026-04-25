/**
 * Skills manager: list, read, save, create skills — all scoped to an
 * active draft.
 *
 * Skills live in two places:
 *   - container/skills/<name>/SKILL.md           (shared baseline, committed)
 *   - .nanoclaw/playground/<draft>/skills/<name>/SKILL.md  (draft overlay)
 *
 * The UI sees a merged view. Editing a container/skills entry triggers
 * copy-on-write into the active draft's overlay. New skills are created
 * directly in the draft overlay. Apply (on session save) promotes draft
 * skills into container/skills.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { CONTAINER_SKILLS_DIR, getDraftPaths } from './paths.js';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export interface SkillSummary {
  name: string;
  description: string;
  origin: 'draft' | 'shared' | 'overlay';
}

function parseDescription(skillMd: string): string {
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const desc = fm.match(/^description:\s*(.+)$/m);
    if (desc) return desc[1].trim();
  }
  const lines = skillMd.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#')) continue;
    if (lines[i]) return lines[i].slice(0, 120);
  }
  return '';
}

function readSkillMd(dir: string, name: string): string | null {
  const p = path.join(dir, name, 'SKILL.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

export function listSkills(draftName: string): SkillSummary[] {
  const { skillsDir } = getDraftPaths(draftName);
  const out = new Map<string, SkillSummary>();

  if (fs.existsSync(CONTAINER_SKILLS_DIR)) {
    for (const name of fs.readdirSync(CONTAINER_SKILLS_DIR)) {
      const full = path.join(CONTAINER_SKILLS_DIR, name);
      if (!fs.statSync(full).isDirectory()) continue;
      const md = readSkillMd(CONTAINER_SKILLS_DIR, name);
      if (md === null) continue;
      out.set(name, {
        name,
        description: parseDescription(md),
        origin: 'shared',
      });
    }
  }

  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      const full = path.join(skillsDir, name);
      if (!fs.statSync(full).isDirectory()) continue;
      const md = readSkillMd(skillsDir, name);
      if (md === null) continue;
      const existing = out.get(name);
      out.set(name, {
        name,
        description: parseDescription(md),
        origin: existing ? 'overlay' : 'draft',
      });
    }
  }

  return Array.from(out.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(
  draftName: string,
  name: string,
): {
  content: string;
  origin: SkillSummary['origin'];
  supportingFiles: string[];
} | null {
  if (!isValidSkillName(name)) return null;
  const { skillsDir } = getDraftPaths(draftName);
  let content: string | null = null;
  let origin: SkillSummary['origin'] = 'shared';
  const draftMd = readSkillMd(skillsDir, name);
  const sharedMd = readSkillMd(CONTAINER_SKILLS_DIR, name);
  if (draftMd !== null) {
    content = draftMd;
    origin = sharedMd !== null ? 'overlay' : 'draft';
  } else if (sharedMd !== null) {
    content = sharedMd;
    origin = 'shared';
  }
  if (content === null) return null;

  const lookIn =
    origin === 'draft' || origin === 'overlay'
      ? skillsDir
      : CONTAINER_SKILLS_DIR;
  const dir = path.join(lookIn, name);
  const supportingFiles: string[] = [];
  const walk = (sub: string) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), {
      withFileTypes: true,
    })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name !== 'SKILL.md') supportingFiles.push(rel);
    }
  };
  if (fs.existsSync(dir)) walk('');

  return { content, origin, supportingFiles };
}

export function saveSkill(
  draftName: string,
  name: string,
  content: string,
): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const { skillsDir } = getDraftPaths(draftName);
  const draftDir = path.join(skillsDir, name);
  const sharedDir = path.join(CONTAINER_SKILLS_DIR, name);
  if (!fs.existsSync(draftDir) && fs.existsSync(sharedDir)) {
    fs.cpSync(sharedDir, draftDir, { recursive: true });
  }
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(path.join(draftDir, 'SKILL.md'), content);
}

export function createSkill(
  draftName: string,
  name: string,
  description: string,
): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const { skillsDir } = getDraftPaths(draftName);
  const draftDir = path.join(skillsDir, name);
  const sharedDir = path.join(CONTAINER_SKILLS_DIR, name);
  if (fs.existsSync(draftDir) || fs.existsSync(sharedDir)) {
    throw new Error(`Skill already exists: ${name}`);
  }
  fs.mkdirSync(draftDir, { recursive: true });
  const template = `---
name: ${name}
description: ${description}
---

# ${name}

Write instructions for when and how the agent should use this skill.

## When to use

- (trigger 1)
- (trigger 2)

## Steps

1. ...
2. ...
`;
  fs.writeFileSync(path.join(draftDir, 'SKILL.md'), template);
}

export function deleteSkill(draftName: string, name: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const { skillsDir } = getDraftPaths(draftName);
  const draftDir = path.join(skillsDir, name);
  if (fs.existsSync(draftDir)) {
    fs.rmSync(draftDir, { recursive: true, force: true });
  }
  const sharedDir = path.join(CONTAINER_SKILLS_DIR, name);
  if (fs.existsSync(sharedDir)) {
    fs.rmSync(sharedDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Agent-created skills — detect skills the agent wrote into the container's
// .claude/skills/ directory that aren't already in the library or draft.
// ---------------------------------------------------------------------------

function agentSkillsDir(draftName: string): string {
  return path.join(DATA_DIR, 'sessions', draftName, '.claude', 'skills');
}

export interface AgentCreatedSkill {
  name: string;
  description: string;
}

export function listAgentCreatedSkills(draftName: string): AgentCreatedSkill[] {
  const { skillsDir } = getDraftPaths(draftName);
  const dir = agentSkillsDir(draftName);
  if (!fs.existsSync(dir)) return [];

  const known = new Set<string>();
  if (fs.existsSync(CONTAINER_SKILLS_DIR)) {
    for (const name of fs.readdirSync(CONTAINER_SKILLS_DIR)) {
      known.add(name);
    }
  }
  if (fs.existsSync(skillsDir)) {
    for (const name of fs.readdirSync(skillsDir)) {
      known.add(name);
    }
  }

  const results: AgentCreatedSkill[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (known.has(name)) continue;
    const skillDir = path.join(dir, name);
    if (!fs.statSync(skillDir).isDirectory()) continue;
    const skillMd = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;
    const content = fs.readFileSync(skillMd, 'utf-8');
    results.push({ name, description: parseDescription(content) });
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

export function promoteAgentSkill(draftName: string, name: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const { skillsDir } = getDraftPaths(draftName);
  const src = path.join(agentSkillsDir(draftName), name);
  if (!fs.existsSync(src) || !fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new Error(`Agent skill not found: ${name}`);
  }
  const dst = path.join(skillsDir, name);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
