import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  listRoster,
  lookupRosterByEmail,
  removeRosterEntry,
  upsertRosterEntry,
} from './classroom-roster.js';

describe('classroom_roster', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => closeDb());

  it('upserts new entries and looks them up by email', () => {
    upsertRosterEntry({ email: 'alice@school.edu', user_id: 'class:student_03' });
    const entry = lookupRosterByEmail('alice@school.edu');
    expect(entry).not.toBeNull();
    expect(entry!.user_id).toBe('class:student_03');
    expect(entry!.agent_group_id).toBeNull();
  });

  it('normalizes email to lowercase on insert and lookup', () => {
    upsertRosterEntry({ email: 'Bob@School.Edu  ', user_id: 'class:student_04' });
    expect(lookupRosterByEmail('bob@school.edu')).not.toBeNull();
    expect(lookupRosterByEmail('BOB@SCHOOL.EDU')).not.toBeNull();
    const all = listRoster();
    expect(all.map((e) => e.email)).toContain('bob@school.edu');
  });

  it('upsert is idempotent on email and replaces user_id + agent_group_id', () => {
    upsertRosterEntry({ email: 'carol@school.edu', user_id: 'class:student_05', agent_group_id: 'agA' });
    upsertRosterEntry({ email: 'carol@school.edu', user_id: 'class:student_05_v2', agent_group_id: 'agB' });
    const entry = lookupRosterByEmail('carol@school.edu')!;
    expect(entry.user_id).toBe('class:student_05_v2');
    expect(entry.agent_group_id).toBe('agB');
    expect(listRoster().filter((e) => e.email === 'carol@school.edu')).toHaveLength(1);
  });

  it('lookup returns null for unknown email', () => {
    expect(lookupRosterByEmail('nobody@school.edu')).toBeNull();
  });

  it('remove drops the row and returns true; second remove returns false', () => {
    upsertRosterEntry({ email: 'dan@school.edu', user_id: 'class:student_06' });
    expect(removeRosterEntry('dan@school.edu')).toBe(true);
    expect(removeRosterEntry('dan@school.edu')).toBe(false);
    expect(lookupRosterByEmail('dan@school.edu')).toBeNull();
  });
});
