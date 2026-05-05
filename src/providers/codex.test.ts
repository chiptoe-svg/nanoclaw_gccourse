/**
 * Unit tests for the codex provider's auth resolver registry
 * (Phase 9.3 + Phase 10.1).
 *
 * The chain semantics are: register newest-wins, walk in order, first
 * non-null resolution returned. Default install registers only the
 * instructor host resolver. The class feature (when imported) prepends
 * a per-student resolver that shadows.
 *
 * Tests reset the chain explicitly per scenario via _resetResolversForTest
 * and re-register the resolvers under test, so cross-test pollution
 * from global module-load registration can't sneak in.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR, FAKE_HOME } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return {
    TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-codex-resolver-test'),
    FAKE_HOME: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-codex-resolver-test-home'),
  };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { studentCodexAuthResolver } from '../class-codex-auth.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup, setAgentGroupMetadataKey } from '../db/agent-groups.js';
import { storeStudentAuth } from '../student-auth.js';
import {
  _resetResolversForTest,
  instructorHostResolver,
  registerCodexAuthResolver,
  resolveCodexAuthSource,
} from './codex.js';

const VALID_AUTH_JSON = JSON.stringify({
  tokens: { access_token: 'a', refresh_token: 'r' },
});

function nowIso(): string {
  return new Date().toISOString();
}

function clearAll(): void {
  for (const dir of [TEST_DIR, FAKE_HOME]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeInstructorAuth(): string {
  const codexDir = path.join(FAKE_HOME, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const p = path.join(codexDir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify({ tokens: { access_token: 'instructor-a', refresh_token: 'instructor-r' } }));
  return p;
}

function seedAgentGroup(id: string, folder: string): void {
  createAgentGroup({
    id,
    name: folder,
    folder,
    agent_provider: 'codex',
    model: null,
    created_at: nowIso(),
  });
}

beforeEach(() => {
  clearAll();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  _resetResolversForTest();
});

afterEach(() => {
  closeDb();
  clearAll();
});

describe('codex auth resolver chain — instructor-only (default install)', () => {
  beforeEach(() => {
    registerCodexAuthResolver(instructorHostResolver);
  });

  it('returns null when no host auth.json exists', () => {
    seedAgentGroup('ag-1', 'student_01');
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME })).toBeNull();
  });

  it('resolves to the instructor host auth when present', () => {
    seedAgentGroup('ag-1', 'student_01');
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ name: 'instructor', path: expected });
  });

  it('returns null when hostHome is undefined', () => {
    seedAgentGroup('ag-1', 'student_01');
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined })).toBeNull();
  });

  it('ignores agent_groups.metadata when no class resolver is registered', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ name: 'instructor', path: expected });
  });
});

describe('codex auth resolver chain — class feature registered', () => {
  beforeEach(() => {
    // Order matches src/index.ts boot sequence: provider's default first,
    // then class extensions. Class registration uses unshift, so it
    // ends up AT the front of the chain → shadows the instructor.
    registerCodexAuthResolver(instructorHostResolver);
    registerCodexAuthResolver(studentCodexAuthResolver);
  });

  it('uses student auth when student_user_id + uploaded auth both present', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    writeInstructorAuth(); // also present — should be shadowed
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result?.name).toBe('student');
    expect(result?.path).toContain('student-auth');
  });

  it('falls back to instructor when class resolver returns null (no upload yet)', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ name: 'instructor', path: expected });
  });

  it('falls back to instructor for non-class agent groups (no student_user_id)', () => {
    seedAgentGroup('ag-1', 'main');
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ name: 'instructor', path: expected });
  });

  it('treats non-string student_user_id as absent (defensive)', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 12345);
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ name: 'instructor', path: expected });
  });

  it('uses student auth even when hostHome is undefined', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined });
    expect(result?.name).toBe('student');
  });

  it('returns null when neither student nor instructor have auth available', () => {
    seedAgentGroup('ag-1', 'main');
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME })).toBeNull();
  });
});

describe('registry semantics', () => {
  it('newest registration wins (unshift order)', () => {
    const callOrder: string[] = [];
    registerCodexAuthResolver(() => {
      callOrder.push('first-registered');
      return null;
    });
    registerCodexAuthResolver(() => {
      callOrder.push('second-registered');
      return { name: 'second', path: '/whatever' };
    });
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined });
    // Second registration was prepended, so it ran first and matched —
    // first-registered never got called.
    expect(callOrder).toEqual(['second-registered']);
    expect(result).toEqual({ name: 'second', path: '/whatever' });
  });

  it('returns null when every resolver returns null', () => {
    registerCodexAuthResolver(() => null);
    registerCodexAuthResolver(() => null);
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined })).toBeNull();
  });
});
