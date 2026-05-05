/**
 * Unit tests for resolveCodexAuthSource — Phase 9.3's per-student
 * source picker that the codex provider's session-spawn callback uses.
 *
 * Real DB + real filesystem (under temp DATA_DIR / temp HOME), so the
 * test exercises the actual call paths into agent_groups.metadata and
 * the student-auth storage layer.
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

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup, setAgentGroupMetadataKey } from '../db/agent-groups.js';
import { storeStudentAuth } from '../student-auth.js';
import { resolveCodexAuthSource } from './codex.js';

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
});

afterEach(() => {
  closeDb();
  clearAll();
});

describe('resolveCodexAuthSource', () => {
  it('returns "none" when there is no per-student auth and no host auth', () => {
    seedAgentGroup('ag-1', 'student_01');
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ source: 'none', path: null });
  });

  it('falls back to the instructor host auth when no student is wired', () => {
    seedAgentGroup('ag-1', 'student_01');
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ source: 'instructor', path: expected });
  });

  it('uses the student auth when student_user_id is set AND a stored auth exists', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    writeInstructorAuth(); // also present — should be ignored
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result.source).toBe('student');
    expect(result.path).toContain('student-auth');
  });

  it('falls back to instructor when student_user_id is set but no auth uploaded yet', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ source: 'instructor', path: expected });
  });

  it('treats non-string student_user_id as absent (defensive)', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 12345);
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ source: 'instructor', path: expected });
  });

  it('returns "none" when hostHome is undefined and no student auth', () => {
    seedAgentGroup('ag-1', 'student_01');
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined });
    expect(result).toEqual({ source: 'none', path: null });
  });

  it('uses student auth even when hostHome is undefined', () => {
    seedAgentGroup('ag-1', 'student_01');
    setAgentGroupMetadataKey('ag-1', 'student_user_id', 'telegram:42');
    storeStudentAuth('telegram:42', VALID_AUTH_JSON);
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined });
    expect(result.source).toBe('student');
  });
});
