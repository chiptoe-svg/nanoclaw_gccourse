/**
 * Class skeleton — bulk-provision N student agent groups for a class.
 *
 * Base script — ships KB + wiki mounts inline. Optional skills (e.g.
 * `/add-classroom-gws`) extend this via `class-skeleton-extensions.ts`,
 * which the script imports for side effects so registered contributors
 * get to add their own per-student mounts and class-config fields.
 *
 * Idempotent: re-runnable. Existing agent_groups rows are kept;
 * container.json is overwritten so re-running picks up new mount
 * paths if KB / wiki / extensions change.
 *
 * Usage (base):
 *   pnpm exec tsx scripts/class-skeleton.ts \
 *     --count 16 \
 *     --names "Alice,Bob,..." \
 *     --kb /srv/class-kb \
 *     --wiki /srv/class-wiki
 *
 * With the gws skill installed, additional flags `--drive-parent
 * <folder-id>` and `--drive-mount-root <path>` become available; they
 * persist gws fields into `data/class-config.json` and emit per-student
 * Drive bind mounts.
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

// Side-effect imports: each registers any extension contributors it
// brings (mount-registry contributors, etc.). Empty barrel in the
// default install; skills like /add-classroom-gws append imports.
import './class-skeleton-extensions.js';

interface CliArgs {
  count: number;
  names: string[];
  kb: string | null;
  wiki: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  const count = parseInt(get('--count') || '16', 10);
  const namesRaw = get('--names');
  const names = namesRaw
    ? namesRaw
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    : Array.from({ length: count }, (_, i) => `Student${String(i + 1).padStart(2, '0')}`);
  if (names.length !== count) {
    throw new Error(`--count is ${count} but --names has ${names.length} entries`);
  }
  return {
    count,
    names,
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

const BASE_PERSONA = (name: string): string => `# ${name}'s agent

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

const SHARED_CLAUDE_MD = `@./.claude-shared.md
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

async function main(): Promise<void> {
  const args = parseArgs();

  // Init DB so we can write agent_groups.
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  console.log(`Provisioning ${args.count} student slots…`);
  if (args.kb) console.log(`  Static KB:           ${args.kb}`);
  if (args.wiki) console.log(`  Wiki:                ${args.wiki}`);
  console.log();

  // class-config.json is written AFTER the loop so extension
  // contributors that mutate it (gws sets driveParent / driveMountRoot)
  // have their fields baked in. Build the base shape here; contributors
  // mutate it as side effects of producing mounts.
  const classConfig: Record<string, unknown> = {
    kb: args.kb,
    wiki: args.wiki,
    students: args.names.map((name, i) => ({ name, folder: studentFolder(i + 1) })),
  };

  const roster: Array<{ name: string; folder: string; code: string }> = [];

  for (let i = 0; i < args.count; i++) {
    const name = args.names[i]!;
    const folder = studentFolder(i + 1);

    // 1. Create / verify agent_groups row
    let group = getAgentGroupByFolder(folder);
    if (group) {
      console.log(`  [skip] ${folder} (${name}) — agent group already exists`);
    } else {
      group = {
        id: shortId('ag'),
        name: folder,
        folder,
        agent_provider: null,
        model: null,
        created_at: nowIso(),
      } as AgentGroup;
      createAgentGroup(group);
      console.log(`  [+]    ${folder} (${name}) — agent group ${group.id}`);
    }

    // 2. Create / refresh the on-disk group folder
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });
    const personaPath = path.join(groupDir, 'CLAUDE.local.md');
    if (!fs.existsSync(personaPath)) {
      fs.writeFileSync(personaPath, BASE_PERSONA(name));
    }
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      fs.writeFileSync(claudeMdPath, SHARED_CLAUDE_MD);
    }
    // Collect any extension-contributed mounts (Drive, etc.) for this
    // student. Contributors may also mutate `classConfig` to persist
    // their own fields — we write the file once after the loop so all
    // mutations are captured.
    const extraMounts = collectSkeletonMounts({
      studentFolder: folder,
      studentName: name,
      classConfig,
      argv: process.argv.slice(2),
    });
    writeContainerConfig(folder, makeContainerConfig({ kb: args.kb, wiki: args.wiki, folder, extraMounts }));

    // 3. Generate pairing code (wire-to that folder).
    // createPairing supersedes any existing pending pairing for the same
    // intent, so re-running issues a fresh code without leaks.
    const pairing = await createPairing({ kind: 'wire-to', folder });
    roster.push({ name, folder, code: pairing.code });
  }

  // Persist class-config.json (after contributors have had a chance
  // to mutate it).
  const classConfigPath = path.join(DATA_DIR, 'class-config.json');
  fs.writeFileSync(classConfigPath, JSON.stringify(classConfig, null, 2));

  // 4. Write roster CSV for distribution.
  const csvPath = path.join(process.cwd(), 'class-roster.csv');
  const lines = ['name,folder,pairing_code,instructions'];
  for (const r of roster) {
    lines.push(`"${r.name}","${r.folder}","${r.code}","DM @<bot_username> with: ${r.code} <your-email>"`);
  }
  fs.writeFileSync(csvPath, lines.join('\n') + '\n');

  console.log(`\nClass config: ${classConfigPath}`);
  console.log(`Roster CSV:   ${csvPath}`);
  console.log(`\n${args.count} pairing codes generated. Distribute to students.`);
}

main().catch((err) => {
  console.error('class-skeleton failed:', err);
  process.exit(1);
});
