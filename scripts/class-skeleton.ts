/**
 * Class skeleton — bulk-provision agent groups for a class.
 *
 * Three role tiers (Phase 12):
 *   - student_NN  — one per student. Default socratic-tutor persona.
 *   - ta_NN       — one per TA. Default TA-assistant persona, scoped admin
 *                   on every student_* and every other ta_* (whole class).
 *   - instructor_NN — one per instructor. Granted global admin on first pair.
 *
 * Provisions DB rows, on-disk group folders, and pairing codes for each
 * member. Optional skills (e.g. /add-classroom-gws) extend this via
 * `class-skeleton-extensions.ts`, which the script imports for side
 * effects so registered contributors can add per-student mounts and
 * mutate class-config fields.
 *
 * Idempotent: re-runnable. Existing agent_groups rows are kept;
 * container.json is overwritten so re-running picks up new mount
 * paths if KB / wiki / extensions change.
 *
 * Usage:
 *   pnpm exec tsx scripts/class-skeleton.ts \
 *     --count 16 \
 *     --names "Alice,Bob,..." \
 *     --tas "Dave,Eve" \
 *     --instructors "Frank,Grace" \
 *     --kb /srv/class-kb \
 *     --wiki /srv/class-wiki
 *
 * --tas and --instructors are optional (defaults to none).
 *
 * With /add-classroom-gws installed, additional flags `--drive-parent
 * <folder-id>` and `--drive-mount-root <path>` become available.
 *
 * Note: each path used as a bind mount must be in the mount allowlist
 * at `~/.config/nanoclaw/mount-allowlist.json` or the host will refuse
 * to spawn the student container.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { createPairing } from '../src/channels/telegram-pairing.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { writeContainerConfig, type ContainerConfig } from '../src/container-config.js';
import { collectSkeletonMounts } from '../src/skeleton-mount-registry.js';
import type { AgentGroup } from '../src/types.js';

import './class-skeleton-extensions.js';

interface ClassMember {
  name: string;
  folder: string;
}

interface CliArgs {
  count: number;
  names: string[];
  tas: string[];
  instructors: string[];
  kb: string | null;
  wiki: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  const splitNames = (raw: string | null): string[] =>
    raw
      ? raw
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
      : [];
  const count = parseInt(get('--count') || '16', 10);
  const namesRaw = get('--names');
  const names = namesRaw
    ? splitNames(namesRaw)
    : Array.from({ length: count }, (_, i) => `Student${String(i + 1).padStart(2, '0')}`);
  if (names.length !== count) {
    throw new Error(`--count is ${count} but --names has ${names.length} entries`);
  }
  return {
    count,
    names,
    tas: splitNames(get('--tas')),
    instructors: splitNames(get('--instructors')),
    kb: get('--kb'),
    wiki: get('--wiki'),
  };
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function studentFolder(n: number): string {
  return `student_${String(n).padStart(2, '0')}`;
}

function taFolder(n: number): string {
  return `ta_${String(n).padStart(2, '0')}`;
}

function instructorFolder(n: number): string {
  return `instructor_${String(n).padStart(2, '0')}`;
}

const STUDENT_PERSONA = (name: string): string => `# ${name}'s agent

You are ${name}'s personal class agent. Help with class assignments,
research, and questions about course material.

## Resources you have

- \`/workspace/kb/\` — class knowledgebase (read-only). Course material,
  syllabus, lecture notes. Check here before saying you don't know.
- \`/workspace/wiki/\` — class wiki (read/write). Shared with all classmates.
  Contributions are git-attributed to ${name}.
- \`/workspace/drive/\` — ${name}'s personal Google Drive folder when the
  Workspace skill is installed. Files saved here sync to ${name}'s Drive.

## Customize me

Edit this file in the playground (\`/playground\` on Telegram) to change my
persona, behavior, and tone. The default above is just a starting point.
`;

const TA_PERSONA = (name: string): string => `# ${name}'s TA agent

You are ${name}, a teaching assistant for this class. Your job is to help
students debug their work, answer questions, and occasionally help the
instructor review submissions.

When a student is stuck, prefer guiding them to the answer over giving
it. When debugging code, walk them through it. When the instructor asks
for a summary, give them concrete details.

## Resources you have

- \`/workspace/kb/\` — class knowledgebase (read-only).
- \`/workspace/wiki/\` — class wiki (read/write). Your contributions are
  git-attributed to ${name}.
- You have admin scope on every \`student_*\` agent group: you can read
  their transcripts, edit their persona via \`/playground\`, and DM
  them via the bot.

## Customize me

Edit this file in the playground to change my persona, behavior, and tone.
The default above is just a starting point.
`;

const INSTRUCTOR_PERSONA = (name: string): string => `# ${name}'s instructor agent

You are ${name}, the instructor for this class. You have global admin —
read every student's transcripts, edit shared CLAUDE.md, manage TAs,
provision/remove students.

Use this agent for course-management tasks: drafting announcements,
reviewing submissions, planning the next lecture, etc. Students and TAs
have their own agents for the day-to-day.

## Resources you have

- \`/workspace/kb/\` — class knowledgebase (read-only).
- \`/workspace/wiki/\` — class wiki (read/write). Your contributions are
  git-attributed to ${name}.
- Global admin: every agent group is reachable.

## Customize me

Edit this file in the playground to change my persona, behavior, and tone.
The default above is just a starting point.
`;

/**
 * Default content for `data/class-shared-students.md`. Symlinked into
 * each student's group dir as `.class-shared.md`. The instructor can
 * edit this one file to change the class-wide stance for every student.
 */
const CLASS_SHARED_STUDENT_MD = `## How you teach

Approach learning Socratically. When a student asks a question, prefer
asking *them* a question that nudges them toward the answer over
delivering the answer directly. When they're stuck on code, ask what
they've tried. When they're confused about a concept, ask what part is
fuzziest.

Don't be obstructionist — if they truly can't make progress after a
couple of nudges, give the answer with a brief explanation of *why*.
Socratic isn't synonymous with cryptic.

When you do give an answer, frame it so the student can verify it
themselves rather than just trusting you.

## Web hosting

When publishing a website, always use \`/var/www/sites/<your-folder>/<sitename>/\`
where \`<your-folder>\` is your group folder name (e.g. \`student_07\`,
\`ta_03\`, \`instructor_01\`). This keeps your sites separate from your
classmates' sites — never write to \`/var/www/sites/\` directly.

The host's Caddy server serves your site at
\`http://<host>/<your-folder>/<sitename>/\`. Send the URL when done.
`;

const STUDENT_CLAUDE_MD = `@./.claude-shared.md
@./.class-shared.md
@./CLAUDE.local.md
`;

const NON_STUDENT_CLAUDE_MD = `@./.claude-shared.md
@./CLAUDE.local.md
`;

function makeContainerConfig(opts: {
  kb: string | null;
  wiki: string | null;
  folder: string;
  extraMounts: ContainerConfig['additionalMounts'];
}): ContainerConfig {
  const additionalMounts: ContainerConfig['additionalMounts'] = [];
  if (opts.kb) {
    additionalMounts.push({ hostPath: opts.kb, containerPath: '/workspace/kb', readonly: true });
  }
  if (opts.wiki) {
    additionalMounts.push({ hostPath: opts.wiki, containerPath: '/workspace/wiki', readonly: false });
  }
  for (const mount of opts.extraMounts) {
    additionalMounts.push(mount);
  }
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts,
    skills: 'all',
    groupName: opts.folder,
    assistantName: opts.folder,
  };
}

interface ProvisionTarget {
  name: string;
  folder: string;
  role: 'student' | 'ta' | 'instructor';
  persona: string;
  /** True for student folders so the on-disk CLAUDE.md pulls in
   *  `.class-shared.md` (the socratic stance). TAs/instructors don't
   *  include it — they have a different mental model. */
  includesClassShared: boolean;
}

function provisionGroup(args: CliArgs, classConfig: Record<string, unknown>, target: ProvisionTarget): string {
  // 1. agent_groups row
  let group = getAgentGroupByFolder(target.folder);
  if (group) {
    console.log(`  [skip] ${target.folder} (${target.name}) — agent group already exists`);
  } else {
    group = {
      id: shortId('ag'),
      name: target.folder,
      folder: target.folder,
      agent_provider: null,
      model: null,
      created_at: nowIso(),
    } as AgentGroup;
    createAgentGroup(group);
    console.log(`  [+]    ${target.folder} (${target.name}) — agent group ${group.id}`);
  }

  // 2. on-disk group dir
  const groupDir = path.join(GROUPS_DIR, target.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const personaPath = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(personaPath)) {
    fs.writeFileSync(personaPath, target.persona);
  }
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, target.includesClassShared ? STUDENT_CLAUDE_MD : NON_STUDENT_CLAUDE_MD);
  }

  // 3. .class-shared.md symlink (students only). Symlink target lives at
  //    DATA_DIR/class-shared-students.md so instructor edits there
  //    propagate to every student on next session spawn.
  if (target.includesClassShared) {
    const classSharedSrc = path.join(DATA_DIR, 'class-shared-students.md');
    const classSharedLink = path.join(groupDir, '.class-shared.md');
    if (!fs.existsSync(classSharedLink)) {
      try {
        fs.symlinkSync(classSharedSrc, classSharedLink);
      } catch (err) {
        // Filesystems without symlink support fall back to a copy. The
        // instructor still gets the file but loses the auto-propagate
        // behavior — they'd have to re-run the skeleton to update it.
        console.warn(`  [warn] symlink failed for ${target.folder}/.class-shared.md, copying instead:`, err);
        fs.copyFileSync(classSharedSrc, classSharedLink);
      }
    }
  }

  // 4. extension-contributed mounts (Drive, etc.)
  const extraMounts = collectSkeletonMounts({
    studentFolder: target.folder,
    studentName: target.name,
    classConfig,
    argv: process.argv.slice(2),
  });
  writeContainerConfig(
    target.folder,
    makeContainerConfig({ kb: args.kb, wiki: args.wiki, folder: target.folder, extraMounts }),
  );

  return group.id;
}

async function main(): Promise<void> {
  const args = parseArgs();

  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const students: ClassMember[] = args.names.map((name, i) => ({ name, folder: studentFolder(i + 1) }));
  const tas: ClassMember[] = args.tas.map((name, i) => ({ name, folder: taFolder(i + 1) }));
  const instructors: ClassMember[] = args.instructors.map((name, i) => ({ name, folder: instructorFolder(i + 1) }));

  console.log(`Provisioning ${students.length} students, ${tas.length} TAs, ${instructors.length} instructors…`);
  if (args.kb) console.log(`  Static KB:           ${args.kb}`);
  if (args.wiki) console.log(`  Wiki:                ${args.wiki}`);
  console.log();

  // Build the class-config blob first so contributors run against the
  // final shape. Persisted after the loop (contributors may mutate it).
  const classConfig: Record<string, unknown> = {
    kb: args.kb,
    wiki: args.wiki,
    students,
    tas,
    instructors,
  };

  // Write data/class-shared-students.md (the socratic + web-hosting
  // template the symlinks point at). Idempotent: only writes if absent
  // so instructor edits aren't clobbered on re-run.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const classSharedPath = path.join(DATA_DIR, 'class-shared-students.md');
  if (!fs.existsSync(classSharedPath)) {
    fs.writeFileSync(classSharedPath, CLASS_SHARED_STUDENT_MD);
  }

  const roster: Array<{ name: string; folder: string; code: string; role: string }> = [];

  // Provision in dependency-friendly order: instructors first (they
  // get global admin on first pair), then TAs (they get scoped admin
  // on every student/ta), then students.
  for (const m of instructors) {
    provisionGroup(args, classConfig, {
      ...m,
      role: 'instructor',
      persona: INSTRUCTOR_PERSONA(m.name),
      includesClassShared: false,
    });
    const pairing = await createPairing({ kind: 'wire-to', folder: m.folder });
    roster.push({ name: m.name, folder: m.folder, code: pairing.code, role: 'instructor' });
  }

  for (const m of tas) {
    provisionGroup(args, classConfig, {
      ...m,
      role: 'ta',
      persona: TA_PERSONA(m.name),
      includesClassShared: false,
    });
    const pairing = await createPairing({ kind: 'wire-to', folder: m.folder });
    roster.push({ name: m.name, folder: m.folder, code: pairing.code, role: 'ta' });
  }

  for (const m of students) {
    provisionGroup(args, classConfig, {
      ...m,
      role: 'student',
      persona: STUDENT_PERSONA(m.name),
      includesClassShared: true,
    });
    const pairing = await createPairing({ kind: 'wire-to', folder: m.folder });
    roster.push({ name: m.name, folder: m.folder, code: pairing.code, role: 'student' });
  }

  const classConfigPath = path.join(DATA_DIR, 'class-config.json');
  fs.writeFileSync(classConfigPath, JSON.stringify(classConfig, null, 2));

  // Roster CSV gains a role column.
  const csvPath = path.join(process.cwd(), 'class-roster.csv');
  const lines = ['role,name,folder,pairing_code,instructions'];
  for (const r of roster) {
    lines.push(
      `"${r.role}","${r.name}","${r.folder}","${r.code}","DM @<bot_username> with: ${r.code} <your-email>"`,
    );
  }
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');

  console.log(`\nClass config:        ${classConfigPath}`);
  console.log(`Class-shared (edit): ${classSharedPath}`);
  console.log(`Roster CSV:          ${csvPath}`);
  console.log(`\n${roster.length} pairing codes generated. Distribute to class members.`);
}

main().catch((err) => {
  console.error('class-skeleton failed:', err);
  process.exit(1);
});
