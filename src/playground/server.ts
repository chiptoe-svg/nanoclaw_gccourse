/**
 * Playground HTTP + WebSocket server.
 *
 * Binds to 127.0.0.1:<port> (default 3002) so Caddy can reverse-proxy
 * `/playground/*` to localhost. The server itself is unaware of the
 * `/playground/` prefix — Caddy's handle_path strips it. When reached
 * directly on localhost, paths start at `/`.
 */
import express, { Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import {
  authCookieFromHeader,
  checkPassword,
  clearAuthCookie,
  issueAuthCookie,
  requireAuth,
} from './auth.js';
import {
  applyDraftToMain,
  computePersonaDiff,
  ensureDraftInitialized,
  getDraftStatus,
  getGlobalClaude,
  resetDraftFromMain,
  writeDraftPersona,
  writeGlobalClaude,
} from './draft.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { importLibrarySkill, listLibrary, previewLibrarySkill } from './library.js';
import { listPersonas, loadPersonaIntoDraft, previewPersona } from './personas.js';
import {
  addSource,
  importSourceSkill,
  listAllSources,
  readSourceFile,
  removeSource,
} from './skill-sources.js';
import { DRAFT_SKILLS_DIR } from './paths.js';
import { DRAFT_ATTACHMENTS_DIR } from './paths.js';
import { invalidateSession, runDraftTurn, stopAllDraftRuns } from './run.js';
import {
  createSkill,
  deleteDraftSkill,
  isValidSkillName,
  listSkills,
  readSkill,
  saveSkill,
} from './skills.js';
import { loadState, updateState } from './state.js';
import { startTraceWatcher, subscribeTrace } from './trace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Public assets live in src/playground/public/ (checked into the repo).
// Resolving via PROJECT_ROOT works whether we're running via tsx (src/) or
// compiled JS (dist/), because tsc won't copy the static files into dist/.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(PROJECT_ROOT, 'src', 'playground', 'public');

function json(res: Response, obj: unknown, status = 200): void {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

export async function startPlaygroundServer(port = 3002, host = '0.0.0.0'): Promise<http.Server> {
  ensureDraftInitialized();
  loadState(); // side-effect: creates state.json if missing
  startTraceWatcher();

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

  // --- Draft persona ---
  app.get('/api/draft', (_req, res) => {
    try {
      json(res, getDraftStatus());
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });
  app.put('/api/draft/persona', (req, res) => {
    const text = String(req.body?.text ?? '');
    writeDraftPersona(text);
    invalidateSession();
    json(res, { ok: true });
  });
  app.get('/api/draft/diff', (_req, res) => {
    json(res, computePersonaDiff());
  });
  app.post('/api/draft/apply', (_req, res) => {
    try {
      const result = applyDraftToMain();
      json(res, { ok: true, ...result });
    } catch (err) {
      json(res, { ok: false, error: String(err) }, 500);
    }
  });
  app.post('/api/draft/reset', (_req, res) => {
    resetDraftFromMain();
    invalidateSession();
    json(res, { ok: true });
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
      json(res, { ok: false, error: 'external_change', currentHash: result.conflict }, 409);
      return;
    }
    // Global content change affects all containers — drop the draft's
    // SDK session too so the next turn picks up the new global context.
    invalidateSession();
    json(res, result);
  });

  // --- Agent-produced file downloads (path-confined to groups/draft/) ---
  app.get('/api/draft/files', (req, res) => {
    const rel = String(req.query.path ?? '');
    if (!rel || rel.includes('..')) {
      res.status(400).end('bad path');
      return;
    }
    const draftDir = resolveGroupFolderPath('draft');
    const abs = path.resolve(draftDir, rel);
    // Confine to draft dir
    const relResolved = path.relative(draftDir, abs);
    if (relResolved.startsWith('..') || path.isAbsolute(relResolved)) {
      res.status(400).end('bad path');
      return;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).end('not found');
      return;
    }
    res.download(abs, path.basename(abs));
  });
  app.put('/api/draft/trace-level', (req, res) => {
    const level = String(req.body?.level ?? 'summary');
    if (!['minimal', 'summary', 'full'].includes(level)) {
      json(res, { error: 'invalid level' }, 400);
      return;
    }
    updateState({ traceLevel: level as 'minimal' | 'summary' | 'full' });
    json(res, { ok: true });
  });

  // --- Draft chat ---
  app.post('/api/draft/messages', async (req, res) => {
    const text = String(req.body?.text ?? '');
    if (!text.trim()) {
      json(res, { error: 'empty message' }, 400);
      return;
    }
    try {
      const result = await runDraftTurn(text);
      json(res, result);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  app.post('/api/draft/attachments', (req, res) => {
    // Attachments are sent as JSON: { files: [{name, base64}] }
    // Simpler than multer for teaching purposes; the UI base64-encodes
    // before POST.
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    fs.mkdirSync(DRAFT_ATTACHMENTS_DIR, { recursive: true });
    const saved: string[] = [];
    for (const f of files) {
      const name = String(f?.name ?? '');
      const data = String(f?.base64 ?? '');
      if (!name || !data) continue;
      // Strip path components for safety.
      const safe = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
      fs.writeFileSync(path.join(DRAFT_ATTACHMENTS_DIR, safe), Buffer.from(data, 'base64'));
      saved.push(safe);
    }
    json(res, { saved });
  });

  // --- Skills ---
  app.get('/api/skills', (_req, res) => {
    json(res, { skills: listSkills() });
  });
  app.get('/api/skills/:name', (req, res) => {
    const name = req.params.name;
    if (!isValidSkillName(name)) {
      json(res, { error: 'invalid name' }, 400);
      return;
    }
    const skill = readSkill(name);
    if (!skill) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, skill);
  });
  app.put('/api/skills/:name', (req, res) => {
    try {
      saveSkill(req.params.name, String(req.body?.content ?? ''));
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });
  app.post('/api/skills', (req, res) => {
    try {
      const name = String(req.body?.name ?? '');
      const description = String(req.body?.description ?? '');
      createSkill(name, description);
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: String(err) }, 400);
    }
  });
  app.delete('/api/skills/:name', (req, res) => {
    try {
      deleteDraftSkill(req.params.name);
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
    try {
      loadPersonaIntoDraft(req.params.category, req.params.name);
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
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  app.delete('/api/skill-sources/:id', (req, res) => {
    try {
      removeSource(req.params.id);
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });
  app.get('/api/skill-sources/:sourceId/skill/:skillName/file', (req, res) => {
    const filePath = String(req.query.path ?? 'SKILL.md');
    const file = readSourceFile(req.params.sourceId, req.params.skillName, filePath);
    if (!file) {
      json(res, { error: 'not found' }, 404);
      return;
    }
    json(res, file);
  });
  app.post('/api/skill-sources/:sourceId/skill/:skillName/import', (req, res) => {
    try {
      importSourceSkill(
        req.params.sourceId,
        req.params.skillName,
        req.body?.overwrite === true,
        DRAFT_SKILLS_DIR,
      );
      invalidateSession();
      json(res, { ok: true });
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

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
    try {
      importLibrarySkill(req.params.category, req.params.name, req.body?.overwrite === true);
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
  wss.on('connection', (ws) => {
    const unsubscribe = subscribeTrace((line) => {
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
