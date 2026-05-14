/**
 * Playground API handlers for the student Telegram pairing flow.
 *
 *   GET  /api/me/telegram             → pairing status + bot handle
 *   POST /api/me/telegram/pair-code   → mint a fresh pair code for this session
 *
 * The actual pair-code lifecycle + Telegram side-effects live in
 * src/class-telegram-pair.ts. These handlers are thin wrappers that
 * authenticate via the playground session cookie and call into that
 * module.
 */
import { issuePairCode, getTelegramPairingFor } from '../../../class-telegram-pair.js';
import { readEnvFile } from '../../../env.js';
import type { PlaygroundSession } from '../auth-store.js';
import type { ApiResult } from '../api/me.js';

interface TelegramStatusBody {
  paired: boolean;
  /** Bot username students DM (without leading @). Always present when a token is configured. */
  botUsername: string | null;
  /** Telegram user ID stored at pairing time. Present iff paired. */
  telegramUserId?: string;
  /** Display label for the paired Telegram account (currently the user_id; later: the @handle). */
  telegramHandle?: string;
}

interface PairCodeBody {
  code: string;
  expiresAt: number;
  botUsername: string | null;
}

let cachedBotUsername: string | null | undefined = undefined;
async function resolveBotUsername(): Promise<string | null> {
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  const token = (process.env.TELEGRAM_BOT_TOKEN || readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) {
    cachedBotUsername = null;
    return null;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    cachedBotUsername = data.ok && data.result?.username ? data.result.username : null;
  } catch {
    cachedBotUsername = null;
  }
  return cachedBotUsername;
}

export async function handleGetTelegramStatus(session: PlaygroundSession): Promise<ApiResult<TelegramStatusBody>> {
  const userId = session.userId;
  if (!userId) return { status: 401, body: { error: 'not signed in' } };
  const pairing = getTelegramPairingFor(userId);
  const botUsername = await resolveBotUsername();
  if (!pairing) {
    return { status: 200, body: { paired: false, botUsername } };
  }
  return {
    status: 200,
    body: {
      paired: true,
      botUsername,
      telegramUserId: pairing.telegramUserId,
      telegramHandle: pairing.telegramHandle,
    },
  };
}

export function handleIssuePairCode(session: PlaygroundSession): ApiResult<PairCodeBody> {
  const userId = session.userId;
  if (!userId) return { status: 401, body: { error: 'not signed in' } };
  const { code, expiresAt } = issuePairCode(userId);
  // botUsername returns null from getMe path if token is missing; the
  // frontend renders generic instructions when it's null.
  return {
    status: 200,
    body: { code, expiresAt, botUsername: cachedBotUsername ?? null },
  };
}
