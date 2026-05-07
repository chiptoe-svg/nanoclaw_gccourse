/**
 * Switch the agent provider for a group in one command.
 *
 * Provider selection lives in three places:
 *
 *   1. `groups/<folder>/container.json` `.provider` — read at next container
 *      spawn to pick which provider's host-side mounts/env apply.
 *   2. `sessions.agent_provider` in `data/v2.db` — read by `session-manager`
 *      to decide which provider class to instantiate inside the container.
 *   3. The running container (if any) — has the OLD provider baked into its
 *      env. Must be stopped so the next inbound message respawns fresh.
 *
 * Forgetting any of the three leaves the system in a half-switched state:
 * a stale running container, a wrong-typed session record, or a config
 * file that disagrees with the live state. This script does all three
 * atomically and prints what changed.
 *
 * Usage:
 *
 *   pnpm exec tsx scripts/switch-provider.ts <group-folder> <provider>
 *
 * Examples:
 *
 *   pnpm exec tsx scripts/switch-provider.ts telegram_main codex
 *   pnpm exec tsx scripts/switch-provider.ts telegram_main claude
 *
 * Persona, skills, CLAUDE.local.md, the wiki, and workspace files are
 * provider-agnostic — they live in the group folder and apply to whichever
 * provider runs next. Per-turn chat history (the in-container session
 * resume state) is provider-specific and does not carry over; the workspace
 * artifacts the agent has written do carry over.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS_DIR = path.join(ROOT, 'groups');
const CENTRAL_DB = path.join(ROOT, 'data', 'v2.db');

function usage(): never {
  console.error('Usage: pnpm exec tsx scripts/switch-provider.ts <group-folder> <provider>');
  console.error('Example: pnpm exec tsx scripts/switch-provider.ts telegram_main codex');
  process.exit(1);
}

function main(): void {
  const [folder, provider] = process.argv.slice(2);
  if (!folder || !provider) usage();

  const groupDir = path.join(GROUPS_DIR, folder);
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (!fs.existsSync(containerJsonPath)) {
    console.error(`No container.json at ${containerJsonPath} — is "${folder}" a real group?`);
    process.exit(2);
  }

  // 1. container.json
  const config = JSON.parse(fs.readFileSync(containerJsonPath, 'utf-8'));
  const previousProvider = config.provider;
  if (previousProvider === provider) {
    console.log(`No change — ${folder} is already on ${provider}.`);
    return;
  }
  config.provider = provider;
  const tmp = `${containerJsonPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, containerJsonPath);

  // 2. sessions.agent_provider
  const db = new Database(CENTRAL_DB);
  const group = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(folder) as
    | { id: string }
    | undefined;
  if (!group) {
    db.close();
    console.error(`No agent_groups row matches folder "${folder}".`);
    process.exit(3);
  }
  const updated = db.prepare('UPDATE sessions SET agent_provider = ? WHERE agent_group_id = ?').run(provider, group.id);
  db.close();

  // 3. Stop any running container for this group so next inbound respawns fresh.
  let stopped = 0;
  try {
    const names = execSync(`docker ps --filter name=nanoclaw-v2-${folder}- --format '{{.Names}}'`, {
      encoding: 'utf-8',
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of names) {
      execSync(`docker stop -t 5 ${name}`, { stdio: 'ignore' });
      stopped += 1;
    }
  } catch (err) {
    console.warn(`Container-stop step failed (continuing): ${err instanceof Error ? err.message : err}`);
  }

  // Report.
  console.log(`Switched ${folder}: ${previousProvider} → ${provider}`);
  console.log(`  container.json     updated`);
  console.log(`  sessions.agent_provider rows updated: ${updated.changes}`);
  console.log(`  containers stopped:  ${stopped}`);
  console.log('');
  console.log('Next inbound message will respawn the container with the new provider.');
}

main();
