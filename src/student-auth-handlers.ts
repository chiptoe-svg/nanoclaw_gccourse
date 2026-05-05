/**
 * Phase 9.5 — host-side handler for the `request_reauth` system action.
 *
 * Wired flow when a student's Codex refresh token expires/revokes:
 *   container detects the failure → writes a system-kind outbound row
 *     `{ action: "request_reauth", reason?: "..." }`
 *   host's delivery loop sees `kind=system`, dispatches via the
 *     registered delivery-action handler below
 *   handler: look up the student's user_id from agent_groups.metadata,
 *     issue a fresh student-auth magic link, deliver a DM with the
 *     URL via the same channel adapter the agent uses.
 *
 * Keeping this in its own file (instead of dropping a registration in
 * student-auth.ts or telegram.ts) for two reasons:
 *   - student-auth.ts is "storage", student-auth-server.ts is "the
 *     web server"; the delivery-action handler is a third concern,
 *     so it earns its own file.
 *   - A future channel (Slack, etc.) may want a different DM phrasing
 *     or formatting; centralizing the action handler here means we
 *     don't fan it out across channel adapters.
 */
import { registerDeliveryAction } from './delivery.js';
import { getAgentGroup, getAgentGroupMetadata } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { buildAuthUrl, issueAuthToken } from './student-auth-server.js';

async function handleRequestReauth(
  content: Record<string, unknown>,
  session: { agent_group_id: string; messaging_group_id: string },
): Promise<void> {
  const reason = typeof content.reason === 'string' ? content.reason : 'auth refresh failed';

  const ag = getAgentGroup(session.agent_group_id);
  if (!ag) {
    log.warn('request_reauth: agent group not found', { sessionAg: session.agent_group_id });
    return;
  }
  const meta = getAgentGroupMetadata(ag.id);
  const userId = typeof meta.student_user_id === 'string' ? meta.student_user_id : null;
  if (!userId) {
    log.warn('request_reauth: agent group has no student_user_id metadata', {
      agentGroupId: ag.id,
      reason,
    });
    return;
  }

  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    log.warn('request_reauth: messaging group not found', { mg: session.messaging_group_id });
    return;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.warn('request_reauth: no delivery adapter available — dropping nudge');
    return;
  }

  let url: string | null = null;
  try {
    const token = issueAuthToken(userId);
    url = buildAuthUrl(token);
  } catch (err) {
    log.error('request_reauth: failed to issue token', {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const messageText = url
    ? `Heads up — your ChatGPT auth needs refreshing (${reason}). Open this link to reconnect: ${url}\n\n(Run \`codex login\` on your laptop again first if you haven't recently.)`
    : `Heads up — your ChatGPT auth needs refreshing (${reason}). Ask your instructor for a fresh auth link (NANOCLAW_PUBLIC_URL isn't configured).`;

  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      null,
      'chat',
      JSON.stringify({ text: messageText }),
      undefined,
    );
    log.info('request_reauth: nudge delivered', {
      userId,
      channel: mg.channel_type,
      reason,
    });
  } catch (err) {
    log.error('request_reauth: delivery failed', {
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

registerDeliveryAction('request_reauth', handleRequestReauth as Parameters<typeof registerDeliveryAction>[1]);
