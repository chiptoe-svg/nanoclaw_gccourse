/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough is deliberately narrow:
 *   CODEX_MODEL — model override the runner reads to pick the codex model.
 *
 * NOT passed through:
 *   OPENAI_API_KEY  — would override the credential-proxy `placeholder` and
 *     leak the real key into container env. The proxy substitutes the real
 *     key on every request based on the placeholder, so the container
 *     never needs to see it.
 *   OPENAI_BASE_URL — would override the proxy URL we set in
 *     container-runner.ts. Containers must route through the proxy.
 *
 * For Codex with ChatGPT subscription auth (the common path), the OAuth
 * token in `auth.json` is the credential — neither OPENAI_API_KEY nor
 * the proxy is involved on that codepath.
 *
 * Per-student auth (Phase 9): when the agent group's metadata carries a
 * `student_user_id` AND that student has uploaded their own auth.json
 * via the magic-link flow, we copy from the student's stored file
 * instead of the host's. Otherwise we fall back to the instructor's
 * host auth.json (so unauthed students keep working on the instructor's
 * tab and there's a graceful migration window).
 */
import fs from 'fs';
import path from 'path';

import { getAgentGroupMetadata } from '../db/agent-groups.js';
import { log } from '../log.js';
import { getStudentAuthPath } from '../student-auth.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Pick the source path for a session's auth.json. Per-student first
 * (when metadata + storage agree), instructor's host auth.json second.
 * Returns null if no source is available — the session-spawn proceeds
 * without an auth.json and Codex itself surfaces the auth-required
 * error to the agent.
 *
 * Pure-ish: filesystem reads only. No mutation.
 */
export function resolveCodexAuthSource(opts: {
  agentGroupId: string;
  hostHome: string | undefined;
}): { source: 'student' | 'instructor' | 'none'; path: string | null } {
  const meta = getAgentGroupMetadata(opts.agentGroupId);
  const studentUserId = typeof meta.student_user_id === 'string' ? meta.student_user_id : null;
  if (studentUserId) {
    const studentPath = getStudentAuthPath(studentUserId);
    if (studentPath) {
      return { source: 'student', path: studentPath };
    }
  }
  if (opts.hostHome) {
    const hostAuth = path.join(opts.hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      return { source: 'instructor', path: hostAuth };
    }
  }
  return { source: 'none', path: null };
}

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const resolved = resolveCodexAuthSource({
    agentGroupId: ctx.agentGroupId,
    hostHome: ctx.hostEnv.HOME,
  });

  if (resolved.path) {
    fs.copyFileSync(resolved.path, path.join(codexDir, 'auth.json'));
    log.info('codex provider: auth source resolved', {
      agentGroupId: ctx.agentGroupId,
      source: resolved.source,
    });
  } else {
    log.warn('codex provider: no auth.json available — session will need /login', {
      agentGroupId: ctx.agentGroupId,
    });
  }

  const env: Record<string, string> = {};
  if (ctx.hostEnv.CODEX_MODEL) env.CODEX_MODEL = ctx.hostEnv.CODEX_MODEL;

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
