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
  diffDraftAgainstTarget,
  discardDraft,
  ensureDraftMessagingGroup,
  ensureDraftWiring,
  getDraftStatus,
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
import { getLibraryCacheStat, listLibrary } from './library.js';
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

  // POST /api/drafts/:folder/messages — body: { text } → forward to router
  const messagesMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/messages$/);
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
  const providerMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/provider$/);
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
  const personaGet = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/persona$/);
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

  // GET /api/drafts/:folder/diff — diff vs target
  const diffMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/diff$/);
  if (method === 'GET' && diffMatch) {
    const draftFolder = diffMatch[1]!;
    try {
      return send(res, 200, {
        diff: diffDraftAgainstTarget(draftFolder),
        status: getDraftStatus(draftFolder),
      });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // GET /api/drafts/:folder/files — list non-hidden files in the draft folder
  const filesListMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/files$/);
  if (method === 'GET' && filesListMatch) {
    const draftFolder = filesListMatch[1]!;
    try {
      const draftDir = path.join(GROUPS_DIR, draftFolder);
      if (!fs.existsSync(draftDir)) return send(res, 404, { error: 'draft folder missing' });
      const files: Array<{ name: string; size: number; mtime: string }> = [];
      const walk = (dir: string, rel: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          const subRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(full, subRel);
          else if (entry.isFile()) {
            const st = fs.statSync(full);
            files.push({ name: subRel, size: st.size, mtime: st.mtime.toISOString() });
          }
        }
      };
      walk(draftDir, '');
      return send(res, 200, { files: files.sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  }

  // GET / PUT /api/drafts/:folder/files/:path — read / write a single file
  const fileMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/files\/(.+)$/);
  if (fileMatch && (method === 'GET' || method === 'PUT')) {
    const draftFolder = fileMatch[1]!;
    const relPath = decodeURIComponent(fileMatch[2]!);
    // Mutation gates (file PUT only — GETs are always allowed). Class
    // feature uses this to lock student drafts down to persona edits.
    if (method === 'PUT') {
      const decision = checkDraftMutation(draftFolder, 'file_put', session.userId);
      if (!decision.allow) return send(res, 403, { error: decision.reason || 'Forbidden' });
    }
    // Path-traversal defense: reject .. or anything that resolves outside.
    if (relPath.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) {
      return send(res, 400, { error: 'invalid path' });
    }
    const draftDir = path.join(GROUPS_DIR, draftFolder);
    const filePath = path.join(draftDir, relPath);
    if (!filePath.startsWith(draftDir + path.sep)) {
      return send(res, 400, { error: 'invalid path' });
    }
    if (method === 'GET') {
      try {
        if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { text: fs.readFileSync(filePath, 'utf8') });
      } catch (err) {
        return send(res, 500, { error: (err as Error).message });
      }
    }
    // PUT
    const body = await readJsonBody(req);
    const text = body.text;
    if (typeof text !== 'string') return send(res, 400, { error: 'text (string) required' });
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, text);
      return send(res, 200, { ok: true, bytes: Buffer.byteLength(text) });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
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

  // GET /api/drafts/:folder/skills — current draft's enabled skills
  // PUT /api/drafts/:folder/skills — set enabled skills (array | 'all')
  const skillsMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/skills$/);
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

  // GET /api/drafts/:folder/stream — Server-Sent Events for outbound messages
  const streamMatch = url.pathname.match(/^\/api\/drafts\/(draft_[A-Za-z0-9_-]+)\/stream$/);
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
