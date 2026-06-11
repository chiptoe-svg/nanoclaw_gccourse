import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config.js')>('../../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-status-api',
  };
});

// Mock container-runner — no real containers in tests
vi.mock('../../../container-runner.js', () => ({
  getActiveContainerCount: vi.fn().mockReturnValue(0),
}));

// Mock playground server status
vi.mock('../server.js', () => ({
  getPlaygroundStatus: vi.fn().mockReturnValue({ running: false, url: null }),
}));

import { classifySessionHealth, rollupHealth, ABSENT_HEARTBEAT } from './status.js';
import { initTestDb, closeDb, runMigrations, getDb } from '../../../db/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { createUser } from '../../../modules/permissions/db/users.js';

const TMP = '/tmp/nanoclaw-test-status-api';
const OWNER_ID = 'playground:owner';
const MEMBER_ID = 'playground:member';

const CEIL = 30 * 60 * 1000;

describe('classifySessionHealth', () => {
  it('running container with a fresh heartbeat → running', () => {
    expect(classifySessionHealth('running', 1000, CEIL)).toBe('running');
  });
  it('running container with a stale/absent heartbeat → stale', () => {
    expect(classifySessionHealth('running', CEIL + 1, CEIL)).toBe('stale');
    expect(classifySessionHealth('running', ABSENT_HEARTBEAT, CEIL)).toBe('stale');
  });
  it('idle/stopped → idle', () => {
    expect(classifySessionHealth('idle', 1000, CEIL)).toBe('idle');
    expect(classifySessionHealth('stopped', ABSENT_HEARTBEAT, CEIL)).toBe('idle');
  });
});

describe('rollupHealth', () => {
  it('no sessions → never', () => {
    expect(rollupHealth([])).toBe('never');
  });
  it('reports the worst state (stale > running > idle)', () => {
    expect(rollupHealth(['idle', 'running', 'stale'])).toBe('stale');
    expect(rollupHealth(['idle', 'running'])).toBe('running');
    expect(rollupHealth(['idle', 'idle'])).toBe('idle');
  });
});

function ownerSession() {
  return { cookieValue: 'owner-cookie', userId: OWNER_ID, createdAt: 0, lastActivityAt: 0 };
}

function nonOwnerSession() {
  return { cookieValue: 'member-cookie', userId: MEMBER_ID, createdAt: 0, lastActivityAt: 0 };
}

describe('handleGetStatus owner-gate', () => {
  beforeEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    initTestDb();
    runMigrations(getDb());
    createUser({ id: OWNER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
    grantRole({
      user_id: OWNER_ID,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date().toISOString(),
    });
    createUser({ id: MEMBER_ID, kind: 'playground', display_name: null, created_at: new Date().toISOString() });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('returns 403 for non-owner (member)', async () => {
    const { handleGetStatus } = await import('./status.js');
    const result = handleGetStatus(nonOwnerSession());
    expect(result.status).toBe(403);
  });

  it('returns 200 for owner with correct shape', async () => {
    const { handleGetStatus } = await import('./status.js');
    const result = handleGetStatus(ownerSession());
    expect(result.status).toBe(200);
    const body = result.body as {
      host: { version: string; gatewayRunning: boolean; activeContainers: number };
      agents: unknown[];
    };
    expect(typeof body.host.version).toBe('string');
    expect(Array.isArray(body.agents)).toBe(true);
  });
});
