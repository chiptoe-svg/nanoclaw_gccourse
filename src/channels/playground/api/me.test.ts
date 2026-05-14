import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaygroundSession } from '../auth-store.js';

const sess = (userId: string | null, cookieValue = 'x'): PlaygroundSession =>
  ({ userId, cookieValue }) as PlaygroundSession;

describe('GET /api/me/agent', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns the user-assigned agent group + user info', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => ({ id: 'ag_123', name: 'Felix', folder: 'telegram_main' }),
    }));
    const { handleGetMyAgent } = await import('./me.js');
    const r = handleGetMyAgent(sess('telegram:42'));
    expect(r.status).toBe(200);
    expect((r.body as { agent: { name: string } }).agent.name).toBe('Felix');
  });

  it('returns 404 when no agent group can be resolved', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleGetMyAgent } = await import('./me.js');
    const r = handleGetMyAgent(sess('telegram:42'));
    expect(r.status).toBe(404);
  });

  it('handles anonymous (userId null) via the fallback path', async () => {
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => ({ id: 'ag_999', name: 'main', folder: 'main' }),
    }));
    const { handleGetMyAgent } = await import('./me.js');
    const r = handleGetMyAgent(sess(null));
    expect(r.status).toBe(200);
    expect((r.body as { agent: { id: string } }).agent.id).toBe('ag_999');
  });
});

describe('POST /api/me/logout', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('handleLogout revokes the current session', async () => {
    let revoked: string | undefined;
    vi.doMock('../auth-store.js', () => ({
      revokeSession: (cookie: string) => {
        revoked = cookie;
      },
      revokeSessionsForUser: () => 0,
    }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleLogout } = await import('./me.js');
    const r = handleLogout(sess('telegram:42', 'cookie-x'));
    expect(r.status).toBe(200);
    expect(revoked).toBe('cookie-x');
  });
});

describe('POST /api/me/logout-all', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('handleLogoutAll revokes all sessions for the user', async () => {
    let revokedUser: string | undefined;
    vi.doMock('../auth-store.js', () => ({
      revokeSession: () => {},
      revokeSessionsForUser: (userId: string) => {
        revokedUser = userId;
        return 3;
      },
    }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleLogoutAll } = await import('./me.js');
    const r = handleLogoutAll(sess('telegram:42', 'cookie-x'));
    expect(r.status).toBe(200);
    expect(revokedUser).toBe('telegram:42');
    expect((r.body as { revoked: number }).revoked).toBe(3);
  });

  it('handleLogoutAll falls back to single-session revoke when userId is null', async () => {
    let revokedCookie: string | undefined;
    vi.doMock('../auth-store.js', () => ({
      revokeSession: (cookie: string) => {
        revokedCookie = cookie;
      },
      revokeSessionsForUser: () => 0,
    }));
    vi.doMock('../../../db/agent-groups.js', () => ({
      getPlaygroundAgentForUser: () => null,
    }));
    const { handleLogoutAll } = await import('./me.js');
    const r = handleLogoutAll(sess(null, 'cookie-x'));
    expect(r.status).toBe(200);
    expect(revokedCookie).toBe('cookie-x');
  });
});
