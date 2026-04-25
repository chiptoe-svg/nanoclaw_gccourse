/**
 * Playground HTTP + WebSocket server.
 *
 * Binds to 127.0.0.1:<port> (default 3002) so Caddy can reverse-proxy
 * `/playground/*` to localhost. The server itself is unaware of the
 * `/playground/` prefix — Caddy's handle_path strips it.
 *
 * Session model (locked):
 *   - GET /api/drafts                 → list drafts whose targets exist
 *   - POST /api/session/start         → lock a draft for editing
 *   - POST /api/session/end           → save (apply) or cancel (restore)
 *   - All other /api/* routes require an active session.
 */
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { PROJECT_ROOT } from '../config.js';
import { getAllRegisteredGroups } from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  authCookieFromHeader,
  checkPassword,
  clearAuthCookie,
  issueAuthCookie,
  requireAuth,
} from './auth.js';
import {
  applyDraft,
  computePersonaDiff,
  getDraftStatus,
  getGlobalClaude,
  seedDraftFromTarget,
  writeDraftPersona,
  writeGlobalClaude,
} from './draft.js';
import {
  importLibrarySkill,
  listLibrary,
  previewLibrarySkill,
} from './library.js';
import { getDraftPaths } from './paths.js';
import {
  listPersonas,
  loadPersonaIntoDraft,
  previewPersona,
} from './personas.js';
import { invalidateSession, runDraftTurn, stopAllDraftRuns } from './run.js';
import {
  endDraftSession,
  getActiveDraft,
  listAvailableDrafts,
  requireActiveDraft,
  startDraftSession,
} from './session.js';
import {
  addSource,
  importSourceSkill,
  listAllSources,
  readSourceFile,
  removeSource,
} from './skill-sources.js';
import {
  createSkill,
  deleteSkill,
  isValidSkillName,
  listAgentCreatedSkills,
  listSkills,
  promoteAgentSkill,
  readSkill,
  saveSkill,
} from './skills.js';
import { loadAuthState, updateDraftState } from './state.js';
import { getActiveDraftName, subscribeTrace } from './trace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(PROJECT_ROOT, 'src', 'playground', 'public');

function json(res: Response, obj: unknown, status = 200): void {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

/**
 * Bootstrap: create draft_<main-folder> if main is registered and its
 * draft doesn't exist yet. Runs once at startup.
 */
function seedDefaultDrafts(): void {
  try {
    const groups = getAllRegisteredGroups();
    for (const g of Object.values(groups)) {
      if (!g.isMain) continue;
      const created = seedDraftFromTarget(g.folder);
      if (created) {
        logger.info(
          { created, targetFolder: g.folder },
          'Seeded default draft from main group',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Default draft seed failed (continuing)');
  }
}

/**
 * Guard middleware — short-circuits with 409 if no session is active.
 * Applies to every route that touches per-draft state.
 */
function requireSession(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const active = getActiveDraft();
  if (!active) {
    json(res, { error: 'no_active_draft' }, 409);
    return;
  }
  next();
}

export async function startPlaygroundServer(
  port = 3002,
  host = '0.0.0.0',
): Promise<http.Server> {
  loadAuthState();
  seedDefaultDrafts();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false }));

  // --- Auth (public) ---
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });
  app.post('/api/login', (req: Request, res: Response) => {
    const password = String(req.body?.password ?? '');
    if (!checkPassword(password)) {
      json(res, { ok: false, error: 'invalid password' }, 401);
      return;
    }
    issueAuthCookie(res);
    json(res, { ok: true });
  });
  app.post('/api/logout', (_req, res) => {
    clearAuthCookie(res);
    json(res, { ok: true });
  });

  // --- Auth gate ---
  app.use(requireAuth);

  // --- Static UI ---
  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use('/static', express.static(PUBLIC_DIR));

  // --- Session management (always allowed post-auth) ---
  app.get('/api/drafts', (_req, res) => {
    json(res, {
      drafts: listAvailableDrafts(),
      active: getActiveDraft(),
    });
  });
  app.get('/api/groups', (_req, res) => {
    const groups = Object.values(getAllRegisteredGroups()).map((g) => ({
      folder: g.folder,
      name: g.name,
    }));
    groups.sort((a, b) => a.name.localeCompare(b.name));
    json(res, { groups, activeDraft: getActiveDraft() });
  });
  app.post('/api/session/start', (req, res) => {
    const draft = String(req.body?.draft ?? '');
    const result = startDraftSession(draft);
    if (!result.ok) {
      const status = result.error === 'session_already_active' ? 409 : 400;
      json(res, { ok: false, error: result.error }, status);
      return;
    }
    json(res, { ok: true, draftName: result.draftName });
  });
  app.post('/api/session/end', (req, res) => {
    const action = String(req.body?.action ?? '');
    if (action !== 'save' && action !== 'cancel') {
      json(res, { ok: false, error: 'invalid_action' }, 400);
      return;
    }
    const result = endDraftSession(action);
    if (!result.ok) {
      json(res, result, 400);
      return;
    }
    json(res, result);
  });

  // --- Gate every route below this line: must have active session ---
  app.use('/api/draft', requireSession);
  app.use('/api/skills', requireSession);
  app.use('/api/personas', requireSession);
  app.use('/api/skill-sources', requireSession);
  app.use('/api/library', requireSession);
  app.use('/api/global', requireSession);

  // --- Draft persona ---
  app.get('/api/draft', (_req, res) => {
    try {
      const draftName = requireActiveDraft();
      json(res, getDraftStatus(draftName));
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });
  app.put('/api/draft/persona', (req, res) => {
    const draftName = requireActiveDraft();
    const text = String(req.body?.text ?? '');
    writeDraftPersona(draftName, text);
    invalidateSession();
    json(res, { ok: true });
  });
  app.get('/api/draft/diff', (_req, res) => {
    const draftName = requireActiveDraft();
    json(res, computePersonaDiff(draftName));
  });
  app.post('/api/draft/apply', (_req, res) => {
    // Apply without ending the session. Used when the user wants to push
    // changes to the target but keep editing.
    try {
      const draftName = requireActiveDraft();
      const result = applyDraft(draftName);
      json(res, { ok: true, ...result });
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500);
    }
  });

  // --- Global CLAUDE.md (loaded into every non-main container) ---
  app.get('/api/global', (_req, res) => {
    try {
      json(res, getGlobalClaude());
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });
  app.put('/api/global', (req, res) => {
    const content = String(req.body?.content ?? '');
    const knownHash = String(req.body?.knownHash ?? '');
    const result = writeGlobalClaude(content, knownHash);
    if (!result.ok) {
      json(
        res,
        { ok: false, error: 'external_change', currentHash: result.conflict },
        409,
      );
      return;
    }
    invalidateSession();
    json(res, result);
  });

  // --- Agent-produced file downloads (path-confined to the active draft) ---
  app.get('/api/draft/files', (req, res) => {
    const draftName = requireActiveDraft();
    const rel = String(req.query.path ?? '');
    if (!rel || rel.includes('..')) {
      res.status(400).end('bad path');
      return;
    }
    const draftDir = resolveGroupFolderPath(draftName);
    const abs = path.resolve(draftDir, rel);
    const relResolved = path.relative(draftDir, abs);
    if (relResolved.startsWith('..') || path.isAbsolute(relResolved)) {
      res.status(400).end('bad path');
      return;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).end('not found');
      return;
    }
    res.sendFile(abs);
  });
  app.put('/api/draft/trace-level', (req, res) => {
    const draftName = requireActiveDraft();
    const level = String(req.body?.level ?? 'summary');
    if (!['minimal', 'summary', 'full'].includes(level)) {
      json(res, { error: 'invalid level' }, 400);
      return;
    }
    updateDraftState(draftName, {
      traceLevel: level as 'minimal' | 'summary' | 'full',
    });
    json(res, { ok: true });
  });

  // --- Draft chat ---
  app.post('/api/draft/messages', async (req, res) => {
    const draftName = requireActiveDraft();
    const text = String(req.body?.text ?? '');
    if (!text.trim()) {
      json(res, { error: 'empty message' }, 400);
      return;
    }
    try {
      const result = await runDraftTurn(draftName, text);
      json(res, result);
    } catch (err) {
      json(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });
  app.post('/api/draft/attachments', (req, res) => {
    const draftName = requireActiveDraft();
    const { attachmentsDir } = getDraftPaths(draftName);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const saved: string[] = [];
    for (const f of files) {
      const name = String(f?.name ?? '');
      const data = String(f?.base64 ?? '');
      if (!name || !data) continue;
      const safe = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
      fs.writeFileSync(
        path.join(attachmentsDir, safe),
        Buffer.from(data, 'base64'),
      );
      saved.push(safe);
    }
    json(res, { saved });
  });

  // --- Skills ---
  app.get('/api/skills', (_req, res) => {
    const draftName = requireActiveDraft();
    json(res, { skills: listSkills(draftName) });
  });
  app.get('/api/skills/agent-created', (_req, res) => {
    const draftName = requireActiveDraft();
    json(res, { skills: listAgentCreatedSkills(draftName) });
  });
  app.get('/api/skills/:name', (req, res) => {
    const draftName = requireActiveDraft();
    const name = req.params.name;
    if (!isValidSkillName(name)) {
      json(res, { error: 'invalid name' }, 400);
      return;
    }
    const skill = readSkill(draftName, name);
    if (!skill) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, skill);
  });
  app.put('/api/skills/:name', (req, res) => {
    const draftName = requireActiveDraft();
    try {
      saveSkill(draftName, req.params.name, String(req.body?.content ?? ''));
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });
  app.post('/api/skills', (req, res) => {
    const draftName = requireActiveDraft();
    try {
      const name = String(req.body?.name ?? '');
      const description = String(req.body?.description ?? '');
      createSkill(draftName, name, description);
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });
  app.post('/api/skills/agent-created/:name/promote', (req, res) => {
    const draftName = requireActiveDraft();
    try {
      promoteAgentSkill(draftName, req.params.name);
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });
  app.delete('/api/skills/:name', (req, res) => {
    const draftName = requireActiveDraft();
    try {
      deleteSkill(draftName, req.params.name);
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });

  // --- Personas library (agency-agents) ---
  app.get('/api/personas', (req, res) => {
    const refresh = req.query.refresh === '1';
    try {
      json(res, { entries: listPersonas(refresh) });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });
  app.get('/api/personas/:category/:name', (req, res) => {
    const p = previewPersona(req.params.category, req.params.name);
    if (!p) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, p);
  });
  app.post('/api/personas/:category/:name/load', (req, res) => {
    const draftName = requireActiveDraft();
    try {
      loadPersonaIntoDraft(draftName, req.params.category, req.params.name);
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });

  // --- Skill sources (multi-source library) ---
  app.get('/api/skill-sources', (req, res) => {
    const refresh = req.query.refresh === '1';
    try {
      json(res, { sources: listAllSources(refresh) });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });
  app.post('/api/skill-sources', (req, res) => {
    try {
      const source = addSource({
        name: String(req.body?.name ?? ''),
        repo: String(req.body?.repo ?? ''),
        path: req.body?.path ? String(req.body.path) : undefined,
        id: req.body?.id ? String(req.body.id) : undefined,
      });
      json(res, { ok: true, source });
    } catch (err) {
      json(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });
  app.delete('/api/skill-sources/:id', (req, res) => {
    try {
      removeSource(req.params.id);
      json(res, { ok: true });
    } catch (err) {
      json(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });
  app.get('/api/skill-sources/:sourceId/skill/:skillName/file', (req, res) => {
    const filePath = String(req.query.path ?? 'SKILL.md');
    const file = readSourceFile(
      req.params.sourceId,
      req.params.skillName,
      filePath,
    );
    if (!file) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, file);
  });
  app.post(
    '/api/skill-sources/:sourceId/skill/:skillName/import',
    (req, res) => {
      const draftName = requireActiveDraft();
      const { skillsDir } = getDraftPaths(draftName);
      try {
        importSourceSkill(
          req.params.sourceId,
          req.params.skillName,
          req.body?.overwrite === true,
          skillsDir,
        );
        invalidateSession();
        json(res, { ok: true });
      } catch (err) {
        json(
          res,
          { error: err instanceof Error ? err.message : String(err) },
          400,
        );
      }
    },
  );

  // --- Library (legacy single-source — kept for backward compat) ---
  app.get('/api/library', (req, res) => {
    const refresh = req.query.refresh === '1';
    try {
      json(res, { entries: listLibrary(refresh) });
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });
  app.get('/api/library/:category/:name', (req, res) => {
    const preview = previewLibrarySkill(req.params.category, req.params.name);
    if (!preview) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, preview);
  });
  app.post('/api/library/:category/:name/import', (req, res) => {
    const draftName = requireActiveDraft();
    try {
      importLibrarySkill(
        draftName,
        req.params.category,
        req.params.name,
        req.body?.overwrite === true,
      );
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });

  // --- Boot HTTP server ---
  const server = http.createServer(app);

  // --- WebSocket trace ---
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws/trace')) {
      socket.destroy();
      return;
    }
    if (!authCookieFromHeader(req.headers.cookie)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/ws/trace', 'http://localhost');
    const requested = url.searchParams.get('group');
    const group = requested ?? getActiveDraftName();
    if (!group) {
      ws.close(1008, 'no_group');
      return;
    }
    const unsubscribe = subscribeTrace(group, (line) => {
      try {
        ws.send(line);
      } catch {
        /* closed */
      }
    });
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
  });

  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      logger.info({ host, port }, 'Playground server listening');
      resolve(server);
    });
    server.on('error', reject);
  });
}

export function stopPlayground(): void {
  stopAllDraftRuns();
}
