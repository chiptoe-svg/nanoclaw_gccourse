/**
 * Phase 9.5 — request a fresh student-auth magic link from the host.
 *
 * The container can't DM students directly. Instead it writes a
 * `system`-kind outbound row with `action: "request_reauth"`; the
 * host's delivery loop sees it, looks up the student via the agent
 * group's metadata, issues a magic link, and DMs the student.
 *
 * Call this from the codex provider (or any other place that detects
 * a credential failure) when the auth.json on disk has gone stale
 * (refresh token revoked, account password changed, subscription
 * lapsed). Idempotent on the host side — re-issued tokens don't
 * invalidate previous ones, so duplicate calls within a short window
 * are harmless.
 *
 * The actual error patterns from Codex's app-server need real-world
 * calibration (Phase 7 smoke test). The detection regex below is a
 * defensive starting point covering common OAuth-style failures.
 */
import { writeMessageOut } from './db/messages-out.js';

function log(msg: string): void {
  console.error(`[auth-nudge] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let lastNudgeAtMs = 0;
const NUDGE_DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * Defensive regex for refresh / unauthorized / token-expired errors.
 * Anything in here triggers a nudge. False positives are cheap (the
 * student gets one extra "your auth needs refreshing" message); false
 * negatives mean the agent appears broken until they re-auth, so err
 * on the side of catching too much.
 */
const AUTH_FAILURE_RE =
  /\b(401|unauthorized|forbidden|authentication failed|auth.*required|refresh.*token.*(invalid|expired)|token.*expired|invalid_grant|invalid.token)\b/i;

export function looksLikeAuthFailure(message: string): boolean {
  return AUTH_FAILURE_RE.test(message);
}

/**
 * Emit a `request_reauth` system action. The reason string is shown
 * to the student in their nudge DM, so keep it human-readable and
 * specific enough to be actionable ("subscription lapsed" beats
 * "401 Unauthorized").
 *
 * Debounced: a single session won't spam the student with multiple
 * nudges within 5 minutes — the first one is the only useful signal,
 * subsequent ones are noise from the same root cause.
 */
export function requestReauth(reason: string): void {
  const now = Date.now();
  if (now - lastNudgeAtMs < NUDGE_DEBOUNCE_MS) {
    log(`auth-nudge: debounced (last ${Math.round((now - lastNudgeAtMs) / 1000)}s ago) — reason="${reason}"`);
    return;
  }
  lastNudgeAtMs = now;
  const requestId = generateId();
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({
      action: 'request_reauth',
      reason: reason.slice(0, 200),
    }),
  });
  log(`auth-nudge: request_reauth emitted (${requestId}) — reason="${reason}"`);
}

/** Test hook — clear debounce for unit tests. */
export function _resetDebounceForTest(): void {
  lastNudgeAtMs = 0;
}
