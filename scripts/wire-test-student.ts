/**
 * One-off: bind an email → canonical class user_id for a single
 * already-provisioned student folder, mint a class-login-token URL, and
 * (optionally) send the same welcome email the full roster flow uses.
 *
 * Usage:
 *   pnpm exec tsx scripts/wire-test-student.ts <email> <folder> [name] [course]
 *
 * If <name> and <course> are both supplied, sends the welcome email via the
 * host Gmail adapter (same body classroom-roster-sheet.ts uses). Omit them
 * to wire-only and print the URL to stdout.
 *
 * Mirrors the wiring portion of classroom-roster-sheet.ts (user upsert,
 * classroom_roster, agent_group_members, class_login_tokens) without the
 * Google Sheets dependency. Suitable for smoke-testing the class-token
 * sign-in flow before running the full roster.
 */
import path from 'path';

import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { upsertRosterEntry } from '../src/db/classroom-roster.js';
import { addMember, hasMembershipRow } from '../src/modules/permissions/db/agent-group-members.js';
import { rotateClassLoginToken } from '../src/class-login-tokens.js';
import { readEnvFile } from '../src/env.js';
import { sendGmailMessage } from '../src/gmail-send.js';

async function main(): Promise<void> {
  const [, , emailArg, folderArg, nameArg, courseArg] = process.argv;
  if (!emailArg || !folderArg) {
    console.error('usage: wire-test-student.ts <email> <folder> [name] [course]');
    process.exit(1);
  }

  const DATA_DIR = path.join(process.cwd(), 'data');
  initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(getDb());

  const group = getAgentGroupByFolder(folderArg);
  if (!group) {
    console.error(`no agent group for folder ${folderArg} — run class-skeleton first`);
    process.exit(1);
  }

  const userId = `class:${folderArg}`;
  const now = new Date().toISOString();

  upsertUser({ id: userId, kind: 'class', display_name: emailArg, created_at: now });
  upsertRosterEntry({ email: emailArg, user_id: userId, agent_group_id: group.id });
  if (!hasMembershipRow(userId, group.id)) {
    addMember({ user_id: userId, agent_group_id: group.id, added_by: null, added_at: now });
  }
  const token = rotateClassLoginToken(userId);

  const base = (
    process.env.PUBLIC_PLAYGROUND_URL ||
    readEnvFile(['PUBLIC_PLAYGROUND_URL']).PUBLIC_PLAYGROUND_URL ||
    'http://localhost:3002'
  ).replace(/\/+$/, '');
  const url = `${base}/?token=${token}`;

  console.log(`user:        ${userId} (${emailArg})`);
  console.log(`agent_group: ${group.id} (${group.folder})`);
  console.log(`login URL:   ${url}`);

  if (nameArg && courseArg) {
    const subject = `Your AI agent for ${courseArg}`;
    const body = [
      `Hi ${nameArg},`,
      '',
      `Your personal AI agent for ${courseArg} is ready. Click the link below to start chatting with it. Bookmark the link — it's how you'll log back in for the rest of the term.`,
      '',
      `→ ${url}`,
      '',
      'On first click you will be asked to enter a 6-digit PIN delivered to this email address. After that, the bookmark alone is enough on the same device.',
      '',
      'If you lose this link, ask your instructor for a fresh one.',
      '',
      `— ${courseArg}`,
    ].join('\n');
    await sendGmailMessage({ to: emailArg, subject, body });
    console.log(`email sent to ${emailArg}`);
  }
}

main().catch((err) => {
  console.error('wire-test-student failed:', err);
  process.exit(1);
});
