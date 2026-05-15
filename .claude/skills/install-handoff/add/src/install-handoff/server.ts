/**
 * Install handoff HTTP server.
 *
 * Serves time-limited, N-use install bundle URLs on INSTALL_HANDOFF_PORT
 * (default 3008). Uses only Node's built-in `http` module — no new deps.
 *
 * Routes:
 *   GET /handoff/:token/install.html  — render install guide (not counted)
 *   GET /handoff/:token/:file         — serve file from bundle (counted)
 *   everything else                   — 404
 *
 * Token validation is performed on EVERY request. For install.html, only
 * getHandoff (non-consuming) is called. For file downloads, getHandoff is
 * called first for a fast 404 path, then the file manifest is checked, then
 * consumeHandoff is called to decrement the counter.
 *
 * Path traversal is prevented by checking the requested filename against the
 * bundle's files manifest (an allowlist) rather than sanitising the path.
 * Filenames in the manifest are set at bundle creation time — they cannot
 * contain path separators, so the stat check in bundler.ts is the trust anchor.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DATA_DIR, INSTALL_HANDOFF_PORT } from '../config.js';
import { log } from '../log.js';
import { consumeHandoff, getHandoff } from './store.js';

// ---------------------------------------------------------------------------
// Module-level server state (one server per process)
// ---------------------------------------------------------------------------

let activeServer: http.Server | null = null;

// ---------------------------------------------------------------------------
// Install page placeholder (Phase 5 will replace this)
// ---------------------------------------------------------------------------

const INSTALL_HTML_PLACEHOLDER = 'install template — populated by Phase 5';

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

/** Parse the URL path into { token, file } or null if the path doesn't match. */
function parsePath(url: string): { token: string; file: string } | null {
  // Expected: /handoff/<token>/<file>
  const m = /^\/handoff\/([^/]+)\/([^/]+)$/.exec(url);
  if (!m) return null;
  return { token: m[1]!, file: m[2]! };
}

function send404(res: http.ServerResponse, reason: string, urlPath: string): void {
  log.warn('install-handoff: 404', { reason, path: urlPath });
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`install handoff: ${reason}`);
}

function send400(res: http.ServerResponse, reason: string): void {
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`install handoff: ${reason}`);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Only GET requests are meaningful.
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const rawUrl = req.url ?? '/';

  const parsed = parsePath(rawUrl);
  if (!parsed) {
    send404(res, 'not found', rawUrl);
    return;
  }

  const { token, file } = parsed;

  // Common validation: resolve the token (without consuming).
  const handoff = getHandoff(token);
  if (!handoff.ok) {
    send404(res, handoff.reason, rawUrl);
    return;
  }

  // -------------------------------------------------------------------------
  // Route: install.html (not counted)
  // -------------------------------------------------------------------------
  if (file === 'install.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(INSTALL_HTML_PLACEHOLDER);
    return;
  }

  // -------------------------------------------------------------------------
  // Route: file download (counted)
  // -------------------------------------------------------------------------

  // Validate the requested filename is in the bundle's manifest (allowlist).
  // This is the primary path-traversal guard: if the name isn't in the
  // manifest, we never touch the filesystem for it.
  const manifestEntry = handoff.files.find((f) => f.name === file);
  if (!manifestEntry) {
    send404(res, 'file not in bundle', rawUrl);
    return;
  }

  // Consume one use. This may fail if a concurrent request raced us to
  // exhaustion (single-process, but multiple awaits could interleave in the
  // event loop — consumeHandoff is synchronous via better-sqlite3, so there
  // is no race in practice, but we check the return value defensively).
  const consumed = consumeHandoff(token);
  if (!consumed.ok) {
    send404(res, consumed.reason, rawUrl);
    return;
  }

  // Build the filesystem path.
  const bundleDir = path.join(DATA_DIR, 'handoffs', token);
  // Only allow the exact filename — no path separators. The manifest
  // allowlist already enforces this, but an explicit check is a cheap
  // belt-and-suspenders guard.
  if (file.includes('/') || file.includes('\\') || file === '..' || file === '.') {
    send400(res, 'invalid filename');
    return;
  }
  const filePath = path.join(bundleDir, file);

  // Stream the file to the response.
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    log.warn('install-handoff: file read error', { file, err: String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('install handoff: internal error reading file');
    }
  });

  stream.on('open', () => {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${file}"`,
      'content-length': String(manifestEntry.size),
    });
    stream.pipe(res);
    log.info('install-handoff: file served', {
      id: consumed.id,
      file,
      current_uses: consumed.current_uses,
      max_uses: consumed.max_uses,
    });
  });
}

// ---------------------------------------------------------------------------
// Public lifecycle API
// ---------------------------------------------------------------------------

/**
 * Start the install handoff HTTP server.
 *
 * Binds to INSTALL_HANDOFF_PORT (default 3008) on `host` (default 0.0.0.0).
 * Throws on EADDRINUSE with a clear message. Idempotent — if a server is
 * already active, returns it immediately.
 */
export function startHandoffServer(host = '0.0.0.0'): Promise<http.Server> {
  if (activeServer) return Promise.resolve(activeServer);

  const port = INSTALL_HANDOFF_PORT;

  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`install-handoff: port ${port} is already in use. Set INSTALL_HANDOFF_PORT to a free port.`));
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      activeServer = server;
      log.info('install-handoff: server listening', { host, port });
      resolve(server);
    });
  });
}

/**
 * Stop the install handoff HTTP server.
 *
 * Idempotent — safe to call even if the server was never started.
 */
export function stopHandoffServer(): Promise<void> {
  if (!activeServer) return Promise.resolve();

  const server = activeServer;
  activeServer = null;

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
