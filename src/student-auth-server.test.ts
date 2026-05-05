/**
 * Integration tests for the student-auth magic-link server.
 *
 * Spins the real http.Server on an OS-assigned port (STUDENT_AUTH_PORT=0)
 * and reads the bound port via the test hook. Exercises:
 *   - GET valid token → upload page
 *   - GET bad token → "link expired" 404
 *   - POST valid token + valid auth.json → persists, returns 200
 *   - POST consumed token → 401 (single-use enforcement)
 *   - POST bad-shape JSON → 400
 *   - POST malformed body → 400
 *   - Unknown route → 404
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return { TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-student-auth-server-test') };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    STUDENT_AUTH_PORT: 0,
    STUDENT_AUTH_BIND_HOST: '127.0.0.1',
    NANOCLAW_PUBLIC_URL: 'https://nano.example.com',
  };
});

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  _getBoundPortForTest,
  _resetTokensForTest,
  _waitForListeningForTest,
  buildAuthUrl,
  issueAuthToken,
  stopStudentAuthServer,
} from './student-auth-server.js';
import { hasStudentAuth } from './student-auth.js';

const VALID_AUTH_JSON = JSON.stringify({
  tokens: { access_token: 'a', refresh_token: 'r' },
});

function clearTestDir(): void {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

async function bootAndGetPort(seedUserId: string): Promise<{ token: string; port: number }> {
  const token = issueAuthToken(seedUserId);
  await _waitForListeningForTest();
  const port = _getBoundPortForTest();
  if (port == null) throw new Error('Server failed to bind');
  return { token, port };
}

describe('student-auth-server', () => {
  beforeEach(() => {
    _resetTokensForTest();
    clearTestDir();
  });

  afterAll(async () => {
    await stopStudentAuthServer();
    clearTestDir();
  });

  describe('buildAuthUrl', () => {
    it('builds a public-URL link when NANOCLAW_PUBLIC_URL is set', () => {
      expect(buildAuthUrl('abc-123')).toBe('https://nano.example.com/student-auth?t=abc-123');
    });

    it('URL-encodes the token', () => {
      expect(buildAuthUrl('a/b+c')).toContain('?t=a%2Fb%2Bc');
    });
  });

  describe('issueAuthToken', () => {
    it('requires a non-empty userId', () => {
      expect(() => issueAuthToken('')).toThrow();
    });

    it('returns unique tokens on each call', () => {
      const a = issueAuthToken('telegram:1');
      const b = issueAuthToken('telegram:1');
      expect(a).not.toBe(b);
    });
  });

  describe('GET /student-auth', () => {
    it('serves the upload page for a valid token', async () => {
      const { token, port } = await bootAndGetPort('telegram:42');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth?t=${token}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Connect your ChatGPT account');
      expect(body).toContain('Drop your');
    });

    it('serves "Link expired" 404 for an unknown token', async () => {
      const { port } = await bootAndGetPort('telegram:42');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth?t=does-not-exist`);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('Link expired');
    });

    it('serves "Link expired" 404 when no token query param', async () => {
      const { port } = await bootAndGetPort('telegram:42');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /student-auth/upload', () => {
    it('persists a valid auth.json and returns 200', async () => {
      const { token, port } = await bootAndGetPort('telegram:77');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: VALID_AUTH_JSON }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(hasStudentAuth('telegram:77')).toBe(true);
    });

    it('rejects a token that has already been consumed (single-use)', async () => {
      const { token, port } = await bootAndGetPort('telegram:88');
      const ok = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: VALID_AUTH_JSON }),
      });
      expect(ok.status).toBe(200);
      const replay = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: VALID_AUTH_JSON }),
      });
      expect(replay.status).toBe(401);
    });

    it('rejects an unknown token', async () => {
      const { port } = await bootAndGetPort('telegram:1');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=bogus`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: VALID_AUTH_JSON }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 400 for malformed JSON body', async () => {
      const { token, port } = await bootAndGetPort('telegram:99');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for valid JSON without authJson field', async () => {
      const { token, port } = await bootAndGetPort('telegram:99');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 + consumes the token when authJson has wrong shape', async () => {
      const { token, port } = await bootAndGetPort('telegram:55');
      const res = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: '{"foo":"bar"}' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/Codex auth/);
      // Token is single-use even on failed shape — caller must request a fresh link.
      const replay = await fetch(`http://127.0.0.1:${port}/student-auth/upload?t=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: VALID_AUTH_JSON }),
      });
      expect(replay.status).toBe(401);
      expect(hasStudentAuth('telegram:55')).toBe(false);
    });
  });

  describe('unknown routes', () => {
    it('returns 404', async () => {
      const { port } = await bootAndGetPort('telegram:1');
      const res = await fetch(`http://127.0.0.1:${port}/random/path`);
      expect(res.status).toBe(404);
    });
  });
});
