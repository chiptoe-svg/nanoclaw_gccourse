/**
 * Class skeleton — bulk-provision N student agent groups for a class.
 *
 * What it does:
 *   - Creates `groups/student_<n>/` for each student (CLAUDE.md, CLAUDE.local.md, container.json)
 *   - Inserts agent_groups row for each
 *   - Generates a 4-digit pairing code via the existing `wire-to` flow
 *   - Writes a roster CSV mapping name ↔ folder ↔ pairing code
 *
 * What it does NOT do (deferred to later phases):
 *   - Drive folder creation (happens at pairing time, in the pair handler)
 *   - Shared KB / wiki mount setup (just records mount paths in container.json)
 *   - Scoped-playground wiring (Phase 5)
 *
 * Idempotent: re-runnable. Existing student groups are skipped (with a log).
 *
 * Usage:
 *   pnpm exec tsx scripts/class-skeleton.ts \
 *     --count 16 \
 *     --names "Alice,Bob,Carol,..." \
 *     --drive-parent <google-drive-folder-id> \
 *     --kb /srv/class-kb \
 *     --wiki /srv/class-wiki
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
import type { AgentGroup } from '../src/types.js';

interface CliArgs {
  count: number;
  names: string[];
  driveParent: string | null;
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
    ? namesRaw.split(',').map((n) => n.trim()).filter(Boolean)
    : Array.from({ length: count }, (_, i) => `Student${String(i + 1).padStart(2, '0')}`);
  if (names.length !== count) {
    throw new Error(`--count is ${count} but --names has ${names.length} entries`);
  }
  return {
    count,
    names,
    driveParent: get('--drive-parent'),
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
- \`/workspace/drive/\` — ${name}'s personal Google Drive folder, also
  shared with the instructor. Files saved here sync to ${name}'s Drive.

## Customize me

Edit this file in the playground (\`/playground\` on Telegram) to change my
persona, behavior, and tone. The default above is just a starting point.
`;

const SHARED_CLAUDE_MD = `@./.claude-shared.md
@./CLAUDE.local.md
`;

function makeContainerConfig(opts: { kb: string | null; wiki: string | null; folder: string }): ContainerConfig {
  const additionalMounts: ContainerConfig['additionalMounts'] = [];
  if (opts.kb) {
    additionalMounts.push({ hostPath: opts.kb, containerPath: '/workspace/kb', readonly: true });
  }
  if (opts.wiki) {
    additionalMounts.push({ hostPath: opts.wiki, containerPath: '/workspace/wiki', readonly: false });
  }
  // Drive mount is added later by the pair-handler once the folder exists.
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
  if (args.driveParent) console.log(`  Drive parent folder: ${args.driveParent}`);
  if (args.kb) console.log(`  Static KB: ${args.kb}`);
  if (args.wiki) console.log(`  Wiki: ${args.wiki}`);
  console.log();

  // Persist the class config so the pair-handler can read drive-parent later.
  const classConfigPath = path.join(DATA_DIR, 'class-config.json');
  fs.writeFileSync(
    classConfigPath,
    JSON.stringify(
      {
        driveParent: args.driveParent,
        kb: args.kb,
        wiki: args.wiki,
        students: args.names.map((name, i) => ({ name, folder: studentFolder(i + 1) })),
      },
      null,
      2,
    ),
  );

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
    // container.json — overwrite (so re-running picks up new mount paths if
    // KB/wiki location changes).
    writeContainerConfig(folder, makeContainerConfig({ kb: args.kb, wiki: args.wiki, folder }));

    // 3. Generate pairing code (wire-to that folder).
    // createPairing supersedes any existing pending pairing for the same
    // intent, so re-running issues a fresh code without leaks.
    const pairing = await createPairing({ kind: 'wire-to', folder });
    roster.push({ name, folder, code: pairing.code });
  }

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
