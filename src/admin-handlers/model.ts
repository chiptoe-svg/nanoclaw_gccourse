/**
 * /model Telegram command — show + switch the per-group model.
 *
 *   /model              show current model + suggested aliases
 *   /model <alias>      switch to alias (e.g. opus, 5.5, 5.4mini)
 *   /model <full-id>    switch to a full provider id
 *   /model reset        clear the override (group uses provider default)
 *
 * Self-registers on import.
 */
import { sendTelegram } from '../channels/telegram.js';
import { registerTelegramCommand } from '../channels/telegram-commands.js';

async function handleModelCommand(token: string, platformId: string, text: string): Promise<boolean> {
  if (!text.startsWith('/model')) return false;

  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return false;

  const { getMessagingGroupByPlatform, getMessagingGroupAgents } = await import('../db/messaging-groups.js');
  const { getAgentGroup } = await import('../db/agent-groups.js');
  const { expandAlias, hintsForProvider, resolveEffectiveModel, setModel } = await import('../model-switch.js');
  const { isContainerRunning, killContainer } = await import('../container-runner.js');
  const { getActiveSessions } = await import('../db/sessions.js');

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
      `${agents.length} agent groups wired to this chat — /model on multi-agent chats not yet supported.`,
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
    const hints = await hintsForProvider(group.agent_provider);
    const aliasWidth = hints.reduce((w, h) => Math.max(w, h.alias.length), 0);
    const list =
      hints.length > 0
        ? hints.map((h) => `  • ${h.alias.padEnd(aliasWidth)}  — ${h.note || h.id}`).join('\n')
        : '  (no hints for this provider)';
    const effective = resolveEffectiveModel(group);
    const modelLine = group.model ? `Model: ${group.model}` : `Model: ${effective} (provider default)`;
    reply =
      `Group: ${group.name}\n` +
      `Provider: ${group.agent_provider ?? 'claude (default)'}\n` +
      `${modelLine}\n` +
      `\n` +
      `Suggested models:\n${list}\n` +
      `\n` +
      `Use /model <alias|full-id> to switch. Aliases above (e.g. "${hints[0]?.alias ?? 'opus'}") expand to the full id.`;
  } else {
    const newModel = arg === 'reset' || arg === 'default' ? null : await expandAlias(group.agent_provider, arg);
    const ok = setModel(group.folder, newModel);
    if (!ok) {
      reply = 'Failed to persist — group not found by folder.';
    } else {
      const sessions = getActiveSessions().filter((s) => s.agent_group_id === group.id);
      for (const s of sessions) {
        if (isContainerRunning(s.id)) {
          try {
            killContainer(s.id, 'model change');
          } catch {
            /* best-effort */
          }
        }
      }
      reply = newModel
        ? `✅ Model set to \`${newModel}\`. Next message uses it. (Server rejects unknown models with a clear error.)`
        : `✅ Model reset — group will use provider default.`;
    }
  }

  await sendTelegram(token, chatId, reply);
  return true;
}

registerTelegramCommand('/model', (ctx) => handleModelCommand(ctx.token, ctx.platformId, ctx.text));
