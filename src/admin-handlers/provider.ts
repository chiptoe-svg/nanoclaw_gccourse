/**
 * /provider Telegram command — switch the per-group agent provider.
 *
 *   /provider            show current provider + hint list
 *   /provider <name>     switch to provider (claude, codex, etc.)
 *
 * Trust-first: any string is accepted. If the provider isn't registered
 * the next spawn fails with a clear error, surfaced as the agent's reply.
 *
 * Self-registers on import.
 */
import { sendTelegram } from '../channels/telegram.js';
import { registerTelegramCommand } from '../channels/telegram-commands.js';

async function handleProviderCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/provider')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('../db/messaging-groups.js');
  const { getAgentGroup } = await import('../db/agent-groups.js');
  const { getCurrentProvider, listProviderHints, setProvider } = await import('../provider-switch.js');

  const mg = getMessagingGroupByPlatform('telegram', platformId);
  const agents = mg ? getMessagingGroupAgents(mg.id) : [];
  if (agents.length === 0) {
    await sendTelegram(token, chatId, 'No agent group wired to this chat.');
    return true;
  }
  if (agents.length > 1) {
    await sendTelegram(
      token,
      chatId,
      `${agents.length} agent groups wired to this chat — /provider on multi-agent chats not yet supported.`,
    );
    return true;
  }
  const group = getAgentGroup(agents[0].agent_group_id);
  if (!group) {
    await sendTelegram(token, chatId, 'Agent group lookup failed.');
    return true;
  }

  const parts = text.trim().split(/\s+/);
  const arg = parts.slice(1).join(' ').trim();
  let reply: string;

  if (!arg) {
    const current = getCurrentProvider(group.folder);
    const hints = listProviderHints();
    const list = hints.map((h) => `  • ${h.name} — ${h.note}`).join('\n');
    reply =
      `Group: ${group.name}\n` +
      `Provider: ${current?.provider ?? 'claude (default)'}\n` +
      `\n` +
      `Available providers:\n${list}\n` +
      `\n` +
      `Use /provider <name> to switch. Persona, CLAUDE.local.md, skills, and the wiki carry over;\n` +
      `per-turn chat history does not (each provider keeps its own session store).`;
  } else {
    const result = setProvider(group.folder, arg);
    if (!result.ok) {
      switch (result.reason) {
        case 'no-change':
          reply = `Already on \`${arg}\` — no change.`;
          break;
        case 'no-container-json':
          reply = `Failed: no container.json for ${group.folder}.`;
          break;
        case 'group-not-found':
          reply = `Failed: agent group not found by folder.`;
          break;
        default:
          reply = `Failed: ${result.reason ?? 'unknown reason'}.`;
      }
    } else {
      reply =
        `✅ Provider: \`${result.previousProvider}\` → \`${result.newProvider}\`. ` +
        `${result.containersStopped ?? 0} container(s) stopped. Next message respawns with the new provider.`;
    }
  }

  await sendTelegram(token, chatId, reply);
  return true;
}

registerTelegramCommand('/provider', (ctx) => handleProviderCommand(ctx.token, ctx.platformId, ctx.text));
