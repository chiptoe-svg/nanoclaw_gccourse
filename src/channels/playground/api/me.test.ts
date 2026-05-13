import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlaygroundSession } from '../auth-store.js';

const sess = (userId: string | null): PlaygroundSession =>
  ({ userId, cookieValue: 'x' }) as PlaygroundSession;

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
