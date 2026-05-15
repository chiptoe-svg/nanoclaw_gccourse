/**
 * Playground REST + SSE routes.
 *
 * Single dispatch entry point: `route(req, res, url, method, session)`.
 * Returns 404 on no match. Each `/api/...` endpoint matches inline; the
 * file is long because the surface is wide, not because the dispatch
 * logic is complex.
 *
 * Mutation gates (file PUT, skills PUT, provider PUT) consult
 * `playground-gate-registry.checkDraftMutation` with the calling
 * session's `userId` so the class feature can lock students down to
 * persona edits without this file knowing anything about the class
 * feature.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  applyDraft,
  createDraft,
  discardDraft,
  ensureDraftMessagingGroup,
  ensureDraftWiring,
  listAgentGroups,
  listDrafts,
} from '../../agent-builder/core.js';
import { GROUPS_DIR } from '../../config.js';
import { readContainerConfig, writeContainerConfig } from '../../container-config.js';
import { isContainerRunning, killContainer } from '../../container-runner.js';
import { getAgentGroupByFolder, updateAgentGroup } from '../../db/agent-groups.js';
import { getActiveSessions, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { InboundEvent } from '../adapter.js';
import { checkDraftMutation } from '../playground-gate-registry.js';
import { getPlatformPrefix, getSetupConfig } from './adapter.js';
import type { PlaygroundSession } from './auth-store.js';
import { readJsonBody, send } from './http-helpers.js';
import { getLibraryCacheStat, listLibrary, listSkillFiles, readSkillFile } from './library.js';
import { handlePersonaLayers } from './api/persona-layers.js';
import {
  handleAutoFillCatalog,
  handleGetModels,
  handlePutActiveModel,
  handlePutLocalCatalogEntry,
  handlePutModels,
} from './api/models.js';
import { isOwner } from '../../modules/permissions/db/user-roles.js';
import { handleGetEntry, handleListLibrary, handleSaveMyEntry } from './api/library.js';
import { handleGetMyAgent, handleLogout, handleLogoutAll } from './api/me.js';
import { registerSseClient } from './sse.js';

export async function route(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  method: string,
  session: PlaygroundSession,
): Promise<void> {
  // GET /api/groups — list non-draft agent groups
  if (method === 'GET' && url.pathname === '/api/groups') {
    return send(res, 200, listAgentGroups());
  }

  // GET /api/drafts — list drafts with target reference
  if (method === 'GET' && url.pathname === '/api/drafts') {
    return send(res, 200, listDrafts());
  }

  // POST /api/drafts — { targetFolder } → create draft + ensure mg+wiring
  if (method === 'POST' && url.pathname === '/api/drafts') {
    const body = await readJsonBody(req);
    const targetFolder = body.targetFolder as string | undefined;
    if (!targetFolder) return send(res, 400, { error: 'targetFolder required' });
    try {
      const draft = createDraft(targetFolder);
      ensureDraftWiring(draft.folder);
      return send(res, 200, draft);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // DELETE /api/drafts/:folder
  const draftMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)$/);
  if (method === 'DELETE' && draftMatch) {
    const draftFolder = draftMatch[1]!;
    try {
      discardDraft(draftFolder);
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // POST /api/drafts/:folder/apply — apply to target
  const applyMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/apply$/);
  if (method === 'POST' && applyMatch) {
    const draftFolder = applyMatch[1]!;
    const body = await readJsonBody(req);
    const keepDraft = !!body.keepDraft;
    try {
      applyDraft(draftFolder, { keepDraft });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // POST /api/drafts/:folder/messages — body: { text } → forward to router.
  // Accepts draft_* (instructor drafts), student_* / ta_* / instructor_*
  // (classroom roles) — anything that's a valid agent_group folder. The
  // route is still gated by playground auth (the session check above);
  // for classroom folders the user must be a member of the agent_group,
  // which is enforced in getPlaygroundAgentForUser at sign-in time.
  const messagesMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/messages$/);
  if (method === 'POST' && messagesMatch) {
    const draftFolder = messagesMatch[1]!;
    const body = await readJsonBody(req);
    const text = body.text as string | undefined;
    if (!text) return send(res, 400, { error: 'text required' });
    const setupConfig = getSetupConfig();
    if (!setupConfig) return send(res, 503, { error: 'adapter not ready' });

    try {
      ensureDraftMessagingGroup(draftFolder);
      ensureDraftWiring(draftFolder);
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }

    const platformId = `${getPlatformPrefix()}${draftFolder}`;
    const messageId = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event: InboundEvent = {
      channelType: 'playground',
      platformId,
      threadId: null,
      message: {
        id: messageId,
        kind: 'chat',
        content: JSON.stringify({ text, sender: 'You', senderId: 'playground-user' }),
        timestamp: new Date().toISOString(),
        isMention: true, // every playground message engages
        isGroup: false,
      },
    };
    void Promise.resolve(setupConfig.onInboundEvent(event)).catch((err) =>
      log.error('Playground onInboundEvent failed', { draftFolder, err }),
    );
    return send(res, 200, { ok: true, messageId });
  }

  // PUT /api/drafts/:folder/provider — body: { provider: 'claude' | 'codex' }
  // Updates the draft agent_group's provider for permanent change, AND sets
  // the active session's agent_provider so the next container spawn picks
  // it up. Kills any running container so the change applies on the next
  // message immediately.
  const providerMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/provider$/);
  if (method === 'PUT' && providerMatch) {
    const draftFolder = providerMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'provider_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const provider = body.provider as string | undefined;
    if (!provider) return send(res, 400, { error: 'provider required' });

    const draft = getAgentGroupByFolder(draftFolder);
    if (!draft) return send(res, 404, { error: 'draft not found' });

    try {
      updateAgentGroup(draft.id, { agent_provider: provider });
      // Apply to any active session for this draft.
      for (const s of getActiveSessions()) {
        if (s.agent_group_id !== draft.id) continue;
        updateSession(s.id, { agent_provider: provider });
        if (isContainerRunning(s.id)) {
          try {
            killContainer(s.id, `provider switched to ${provider}`);
          } catch {
            /* best-effort */
          }
        }
      }
      return send(res, 200, { ok: true, provider });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/persona — read CLAUDE.local.md
  const personaGet = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/persona$/);
  if (method === 'GET' && personaGet) {
    const draftFolder = personaGet[1]!;
    try {
      const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
      const text = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf8') : '';
      return send(res, 200, { text });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // PUT /api/drafts/:folder/persona — write CLAUDE.local.md
  if (method === 'PUT' && personaGet) {
    const draftFolder = personaGet[1]!;
    const body = await readJsonBody(req);
    const text = body.text;
    if (typeof text !== 'string') return send(res, 400, { error: 'text (string) required' });
    try {
      const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
      fs.mkdirSync(path.dirname(personaPath), { recursive: true });
      fs.writeFileSync(personaPath, text);
      return send(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/persona-layers — provider-uniform layered view
  const personaLayersMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/persona-layers$/);
  if (method === 'GET' && personaLayersMatch) {
    const result = handlePersonaLayers(personaLayersMatch[1]!);
    return send(res, result.status, result.body);
  }

  // GET /api/me/agent — agent group assigned to this user (with fallback)
  if (method === 'GET' && url.pathname === '/api/me/agent') {
    const r = handleGetMyAgent(session);
    return send(res, r.status, r.body);
  }

  // POST /api/me/logout — revoke current session
  if (method === 'POST' && url.pathname === '/api/me/logout') {
    const r = handleLogout(session);
    return send(res, r.status, r.body);
  }

  // POST /api/me/logout-all — revoke all sessions for this user
  if (method === 'POST' && url.pathname === '/api/me/logout-all') {
    const r = handleLogoutAll(session);
    return send(res, r.status, r.body);
  }

  // GET /api/me/telegram — pairing status + bot handle for the Settings UI.
  if (method === 'GET' && url.pathname === '/api/me/telegram') {
    const { handleGetTelegramStatus } = await import('./api/telegram-pair.js');
    const r = await handleGetTelegramStatus(session);
    return send(res, r.status, r.body);
  }
  // POST /api/me/telegram/pair-code — issue a fresh code for this session's user.
  if (method === 'POST' && url.pathname === '/api/me/telegram/pair-code') {
    const { handleIssuePairCode } = await import('./api/telegram-pair.js');
    const r = handleIssuePairCode(session);
    return send(res, r.status, r.body);
  }

  // GET /api/library — returns all three tiers
  if (method === 'GET' && url.pathname === '/api/library') {
    const r = handleListLibrary(session.userId ?? '');
    return send(res, r.status, r.body);
  }

  // GET /api/library/:tier/:name — single entry
  // POST /api/library/my/:name — save current draft as my-library entry
  const entryMatch = url.pathname.match(/^\/api\/library\/(default|class|my)\/([A-Za-z0-9][A-Za-z0-9_-]*)$/);
  if (entryMatch) {
    if (method === 'GET') {
      const r = handleGetEntry(entryMatch[1]!, entryMatch[2]!, session.userId ?? '');
      return send(res, r.status, r.body);
    }
    if (method === 'POST' && entryMatch[1] === 'my') {
      const body = await readJsonBody(req);
      const r = handleSaveMyEntry(session.userId ?? '', entryMatch[2]!, body as never);
      return send(res, r.status, r.body);
    }
  }

  // GET /api/skills/library — list anthropic/skills cache contents
  if (method === 'GET' && url.pathname === '/api/skills/library') {
    try {
      const refresh = url.searchParams.get('refresh') === '1';
      return send(res, 200, { entries: listLibrary(refresh), cache: getLibraryCacheStat() });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // POST /api/skills/library/refresh — explicit git pull
  if (method === 'POST' && url.pathname === '/api/skills/library/refresh') {
    try {
      return send(res, 200, { entries: listLibrary(true), cache: getLibraryCacheStat() });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/skills/library/:category/:name/files
  const skillFilesMatch = url.pathname.match(
    /^\/api\/skills\/library\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/files$/,
  );
  if (method === 'GET' && skillFilesMatch) {
    return send(res, 200, { files: listSkillFiles(skillFilesMatch[1]!, skillFilesMatch[2]!) });
  }

  // GET /api/skills/library/:category/:name/file?path=<relPath>
  const skillFileMatch = url.pathname.match(
    /^\/api\/skills\/library\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/file$/,
  );
  if (method === 'GET' && skillFileMatch) {
    const relPath = url.searchParams.get('path') || 'SKILL.md';
    const text = readSkillFile(skillFileMatch[1]!, skillFileMatch[2]!, relPath);
    if (text === undefined) return send(res, 404, { error: 'not found' });
    return send(res, 200, { text });
  }

  // GET /api/drafts/:folder/skills — current draft's enabled skills
  // PUT /api/drafts/:folder/skills — set enabled skills (array | 'all')
  const skillsMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/skills$/);
  if (method === 'GET' && skillsMatch) {
    const draftFolder = skillsMatch[1]!;
    try {
      const cfg = readContainerConfig(draftFolder);
      return send(res, 200, { skills: cfg.skills });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }
  if (method === 'PUT' && skillsMatch) {
    const draftFolder = skillsMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'skills_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const skills = body.skills as string[] | 'all' | undefined;
    if (skills === undefined || (skills !== 'all' && !Array.isArray(skills))) {
      return send(res, 400, { error: 'skills must be string[] or "all"' });
    }
    try {
      const cfg = readContainerConfig(draftFolder);
      cfg.skills = skills;
      writeContainerConfig(draftFolder, cfg);
      return send(res, 200, { ok: true, skills });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/models — catalog + current whitelist
  // PUT /api/drafts/:folder/models — set allowedModels
  const modelsMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/models$/);
  if (method === 'GET' && modelsMatch) {
    const r = await handleGetModels(modelsMatch[1]!);
    return send(res, r.status, r.body);
  }
  if (method === 'PUT' && modelsMatch) {
    const draftFolder = modelsMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'models_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const r = handlePutModels(draftFolder, body);
    return send(res, r.status, r.body);
  }

  // PUT /api/drafts/:folder/active-model — set provider + model atomically
  const activeModelMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/active-model$/);
  if (method === 'PUT' && activeModelMatch) {
    const draftFolder = activeModelMatch[1]!;
    {
      const decision = checkDraftMutation(draftFolder, 'models_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    const body = await readJsonBody(req);
    const r = handlePutActiveModel(draftFolder, body);
    return send(res, r.status, r.body);
  }

  // PUT /api/catalog/local-entries — append/replace a curated entry in
  // config/model-catalog-local.json. Owner-only because the file is global
  // (not draft-scoped) and getModelCatalog() reads it on every API call.
  if (method === 'PUT' && url.pathname === '/api/catalog/local-entries') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required to edit the model catalog' });
    }
    const body = await readJsonBody(req);
    const r = handlePutLocalCatalogEntry(body);
    return send(res, r.status, r.body);
  }

  // POST /api/catalog/auto-fill — best-effort metadata lookup. HF API for
  // local, hardcoded table for claude/codex. Owner-only because it can hit
  // external services (HuggingFace) on the host's behalf.
  if (method === 'POST' && url.pathname === '/api/catalog/auto-fill') {
    if (!session.userId || !isOwner(session.userId)) {
      return send(res, 403, { error: 'owner role required' });
    }
    const body = await readJsonBody(req);
    const r = await handleAutoFillCatalog(body);
    return send(res, r.status, r.body);
  }

  // GET /api/drafts/:folder/stream — Server-Sent Events for outbound messages.
  // Same folder-name loosening as the messages POST above so classroom
  // students get a live stream from their student_NN agent.
  const streamMatch = url.pathname.match(/^\/api\/drafts\/([A-Za-z0-9_-]+)\/stream$/);
  if (method === 'GET' && streamMatch) {
    const draftFolder = streamMatch[1]!;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: {"draftFolder":"${draftFolder}"}\n\n`);
    const cleanup = registerSseClient({ draftFolder, cookieValue: session.cookieValue, res });
    req.on('close', cleanup);
    return;
  }

  send(res, 404, { error: `No route: ${method} ${url.pathname}` });
}
