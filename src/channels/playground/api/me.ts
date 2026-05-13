import { getPlaygroundAgentForUser } from '../../../db/agent-groups.js';
import { revokeSession, revokeSessionsForUser } from '../auth-store.js';
import type { PlaygroundSession } from '../auth-store.js';

export interface ApiResult<T> {
  status: number;
  body: T | { error: string };
}

export interface MyAgentResponse {
  user: { id: string | null };
  agent: { id: string; name: string; folder: string };
}

export function handleGetMyAgent(session: PlaygroundSession): ApiResult<MyAgentResponse> {
  const agent = getPlaygroundAgentForUser(session.userId);
  if (!agent) return { status: 404, body: { error: 'no agent group available' } };
  return {
    status: 200,
    body: {
      user: { id: session.userId },
      agent: { id: agent.id, name: agent.name, folder: agent.folder },
    },
  };
}

export function handleLogout(session: PlaygroundSession): ApiResult<{ ok: true }> {
  revokeSession(session.cookieValue, 'user-logout');
  return { status: 200, body: { ok: true } };
}

export function handleLogoutAll(session: PlaygroundSession): ApiResult<{ ok: true; revoked: number }> {
  if (!session.userId) {
    revokeSession(session.cookieValue, 'user-logout');
    return { status: 200, body: { ok: true, revoked: 1 } };
  }
  const revoked = revokeSessionsForUser(session.userId);
  return { status: 200, body: { ok: true, revoked } };
}
