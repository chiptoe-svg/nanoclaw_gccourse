/**
 * Classroom roster — email → user_id mapping.
 *
 * Phase 2 of plans/classroom-web-multiuser.md. Populated either by
 * /add-classroom's --roster <csv> flag (deferred follow-up against the
 * classroom branch) or by `ncl` inserts in the meantime. Consumed by
 * the Google OAuth callback in src/channels/playground/google-oauth.ts:
 * the email Google asserts is normalized to lowercase, looked up here,
 * and on hit produces the canonical user_id (e.g. `class:student_03`)
 * to bind to the new playground session.
 */
import { getDb } from './connection.js';

export interface ClassroomRosterEntry {
  email: string; // normalized lowercase
  user_id: string; // e.g. 'class:student_03'
  agent_group_id: string | null;
  added_at: number; // ms since epoch
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function lookupRosterByEmail(email: string): ClassroomRosterEntry | null {
  const row = getDb()
    .prepare('SELECT email, user_id, agent_group_id, added_at FROM classroom_roster WHERE email = ?')
    .get(normalizeEmail(email)) as ClassroomRosterEntry | undefined;
  return row ?? null;
}

export function listRoster(): ClassroomRosterEntry[] {
  return getDb()
    .prepare('SELECT email, user_id, agent_group_id, added_at FROM classroom_roster ORDER BY email')
    .all() as ClassroomRosterEntry[];
}

/**
 * UPSERT — re-running /add-classroom with the same roster CSV is
 * idempotent on email. Replacing user_id is allowed (a roster reset can
 * remap a student to a different agent_group); added_at always reflects
 * the most-recent add.
 */
export function upsertRosterEntry(entry: { email: string; user_id: string; agent_group_id?: string | null }): void {
  getDb()
    .prepare(
      `INSERT INTO classroom_roster (email, user_id, agent_group_id, added_at)
       VALUES (@email, @user_id, @agent_group_id, @added_at)
       ON CONFLICT(email) DO UPDATE SET
         user_id        = excluded.user_id,
         agent_group_id = excluded.agent_group_id,
         added_at       = excluded.added_at`,
    )
    .run({
      email: normalizeEmail(entry.email),
      user_id: entry.user_id,
      agent_group_id: entry.agent_group_id ?? null,
      added_at: Date.now(),
    });
}

export function removeRosterEntry(email: string): boolean {
  const info = getDb().prepare('DELETE FROM classroom_roster WHERE email = ?').run(normalizeEmail(email));
  return info.changes > 0;
}
