/**
 * /auth Telegram command — switch between API-key and OAuth credential modes.
 *
 *   /auth         show current mode + OAuth-credential validity
 *   /auth api     switch to API key mode
 *   /auth oauth   switch to OAuth mode (validates credentials first)
 *
 * Self-registers on import.
 */
import { log } from '../log.js';
import { registerTelegramCommand } from '../channels/telegram-commands.js';

async function handleAuthCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/auth')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getCurrentAuthMode, hasValidOAuthCredentials, switchAuthMode } = await import('../auth-switch.js');

  const parts = text.trim().split(/\s+/);
  const subcommand = parts[1]?.toLowerCase();

  let reply: string;

  if (!subcommand) {
    const mode = getCurrentAuthMode();
    const oauthOk = hasValidOAuthCredentials();
    reply =
      `Current mode: *${mode}*\n` +
      `OAuth credentials: ${oauthOk ? '✅ valid' : '❌ missing or expired'}\n\n` +
      `Use \`/auth api\` or \`/auth oauth\` to switch.`;
  } else if (subcommand === 'api') {
    await switchAuthMode('api-key');
    reply = '✅ Switched to API key mode. Restarting…';
  } else if (subcommand === 'oauth') {
    if (!hasValidOAuthCredentials()) {
      reply = '❌ No valid OAuth credentials found. Run `claude login` first.';
    } else {
      await switchAuthMode('oauth');
      reply = '✅ Switched to OAuth mode. Restarting…';
    }
  } else {
    reply = `Unknown subcommand: \`${subcommand}\`\nUsage: /auth | /auth api | /auth oauth`;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply, parse_mode: 'Markdown' }),
    });
  } catch (err) {
    log.warn('Failed to send /auth reply', { platformId, err });
  }

  return true;
}

registerTelegramCommand('/auth', (ctx) => handleAuthCommand(ctx.token, ctx.platformId, ctx.text));
