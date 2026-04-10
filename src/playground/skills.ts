/**
 * Skills manager: list, read, save, create skills.
 *
 * Skills live in two places:
 *   - container/skills/<name>/SKILL.md  (shared, committed)
 *   - .nanoclaw/playground/draft/skills/<name>/SKILL.md  (draft overlay)
 *
 * The UI sees a merged view. Editing a container/skills entry triggers
 * copy-on-write into draft/skills/. New skills are created directly in
 * draft/skills/. Apply promotes draft skills into container/skills.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  CONTAINER_SKILLS_DIR,
  DRAFT_GROUP_FOLDER,
  DRAFT_SKILLS_DIR,
} from './paths.js';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

export interface SkillSummary {
  name: string;
  description: string;
  // "draft"   = only in draft overlay (new or edited)
  // "shared"  = only in container/skills (untouched baseline)
  // "overlay" = shadowed: edited in draft, original still exists
  origin: 'draft' | 'shared' | 'overlay';
}

function parseDescription(skillMd: string): string {
  const fmMatch = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const desc = fm.match(/^description:\s*(.+)$/m);
    if (desc) return desc[1].trim();
  }
  // Fallback: first non-empty line after the heading
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

export function listSkills(): SkillSummary[] {
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

  if (fs.existsSync(DRAFT_SKILLS_DIR)) {
    for (const name of fs.readdirSync(DRAFT_SKILLS_DIR)) {
      const full = path.join(DRAFT_SKILLS_DIR, name);
      if (!fs.statSync(full).isDirectory()) continue;
      const md = readSkillMd(DRAFT_SKILLS_DIR, name);
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

/**
 * Read the effective SKILL.md (draft overlay first, then shared).
 * Returns null if the skill doesn't exist in either location.
 */
export function readSkill(name: string): {
  content: string;
  origin: SkillSummary['origin'];
  supportingFiles: string[];
} | null {
  if (!isValidSkillName(name)) return null;
  let content: string | null = null;
  let origin: SkillSummary['origin'] = 'shared';
  const draftMd = readSkillMd(DRAFT_SKILLS_DIR, name);
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
      ? DRAFT_SKILLS_DIR
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

/**
 * Save SKILL.md. If the skill only exists in container/skills, copy the
 * whole directory into draft/skills first (copy-on-write), then write.
 */
export function saveSkill(name: string, content: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const draftDir = path.join(DRAFT_SKILLS_DIR, name);
  const sharedDir = path.join(CONTAINER_SKILLS_DIR, name);
  if (!fs.existsSync(draftDir) && fs.existsSync(sharedDir)) {
    fs.cpSync(sharedDir, draftDir, { recursive: true });
  }
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(path.join(draftDir, 'SKILL.md'), content);
}

export function createSkill(name: string, description: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const draftDir = path.join(DRAFT_SKILLS_DIR, name);
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

/**
 * Remove a skill from the library entirely — both the draft overlay and
 * the shared container/skills copy. The skill will reappear in "Available
 * skills" if it came from an external source (Anthropic library, etc.)
 * so the student can re-add it if they change their mind.
 */
export function deleteSkill(name: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const draftDir = path.join(DRAFT_SKILLS_DIR, name);
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

function agentSkillsDir(): string {
  return path.join(DATA_DIR, 'sessions', DRAFT_GROUP_FOLDER, '.claude', 'skills');
}

export interface AgentCreatedSkill {
  name: string;
  description: string;
}

/**
 * Return skills that exist in the draft container's session skills dir
 * but NOT in container/skills/ and NOT in .nanoclaw/playground/draft/skills/.
 * These were created by the agent during a playground chat session.
 */
export function listAgentCreatedSkills(): AgentCreatedSkill[] {
  const dir = agentSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const known = new Set<string>();
  if (fs.existsSync(CONTAINER_SKILLS_DIR)) {
    for (const name of fs.readdirSync(CONTAINER_SKILLS_DIR)) {
      known.add(name);
    }
  }
  if (fs.existsSync(DRAFT_SKILLS_DIR)) {
    for (const name of fs.readdirSync(DRAFT_SKILLS_DIR)) {
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

/**
 * Promote an agent-created skill into draft/skills/ so it becomes part
 * of the student's skill library. Copies the entire skill folder.
 */
export function promoteAgentSkill(name: string): void {
  if (!isValidSkillName(name)) throw new Error(`Invalid skill name: ${name}`);
  const src = path.join(agentSkillsDir(), name);
  if (!fs.existsSync(src) || !fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new Error(`Agent skill not found: ${name}`);
  }
  const dst = path.join(DRAFT_SKILLS_DIR, name);
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
