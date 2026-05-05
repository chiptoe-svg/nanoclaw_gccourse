/**
 * Class feature — /login Telegram command.
 *
 * Issues a fresh student-auth magic-link token for the message author
 * and DMs the URL. Idempotent — students can re-issue any time (if
 * they lose the link, refresh-token expires, etc.). When
 * NANOCLAW_PUBLIC_URL isn't configured we surface a "ask your
 * instructor" message instead of a broken localhost URL.
 *
 * Lives outside `src/channels/telegram.ts` so the Telegram channel
 * core stays class-agnostic (Phase 10 goal). When Phase 8 eventually
 * extracts the class feature to a sibling branch, this file moves
 * with the rest of the class-* files.
 */
import { registerTelegramCommand, type TelegramCommandHandler } from './channels/telegram-commands.js';
import { sendTelegramText } from './channels/telegram.js';
import { log } from './log.js';
import { buildAuthUrl, issueAuthToken } from './student-auth-server.js';

const handler: TelegramCommandHandler = async (ctx) => {
  if (!ctx.authorUserId) return false;
  const userId = `telegram:${ctx.authorUserId}`;
  let reply: string;
  try {
    const authToken = issueAuthToken(userId);
    const url = buildAuthUrl(authToken);
    reply = url
      ? `Open this link to connect your ChatGPT account: ${url}\n\n(Link is single-use and expires in 30 minutes.)`
      : "I can't generate a link right now — your instructor needs to set NANOCLAW_PUBLIC_URL. Ping them.";
  } catch (err) {
    log.warn('class /login: failed to issue token', {
      err: err instanceof Error ? err.message : String(err),
    });
    reply = "Sorry, I couldn't issue an auth link. Try again or contact your instructor.";
  }
  await sendTelegramText(ctx.token, ctx.platformId, reply, '/login');
  return true;
};

registerTelegramCommand('/login', handler);
