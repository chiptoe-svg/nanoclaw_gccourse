/**
 * Playground HTTP server lifecycle + request dispatch.
 *
 * `startPlaygroundServer` lazily binds the port (host doesn't open one
 * until /playground is sent on Telegram or the OAuth callback fires);
 * `stopPlaygroundServer` revokes everyone and closes the listener.
 *
 * `handleRequest` is the dispatch entry point:
 *   - Public endpoints (/auth, /oauth/google/start, /oauth/google/callback,
 *     /login) bypass the cookie check.
 *   - HTML page paths get a friendlier 302 → /login on auth miss; XHR
 *     and asset paths get 401 so client code sees the real error.
 *   - Authed requests fall through to static-asset routes (home page +
 *     workbench under /playground/) or the API router in
 *     `api-routes.ts`.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { PLAYGROUND_BIND_HOST, PLAYGROUND_ENABLED, PLAYGROUND_PORT } from '../../config.js';
import { log } from '../../log.js';
import { route } from './api-routes.js';
import { getSetupConfig } from './adapter.js';
import {
  COOKIE_NAME,
  createSessionFromMagicToken,
  formatSessionCookie,
  getSessionByCookie,
  hasLostLinkRecoverer,
  mintMagicToken,
  type PlaygroundSession,
  recoverLostLink,
  redeemClassToken,
  revokeAllSessions,
  startIdleSweep,
  stopIdleSweep,
} from './auth-store.js';
import { handleOAuthCallback, handleOAuthStart } from './google-oauth.js';
import { parseCookie, readJsonBody, send } from './http-helpers.js';

let server: http.Server | null = null;

// Public assets live under src/ regardless of whether tsc has copied them
// into dist/. cwd is always the project root for both `node dist/index.js`
// (systemd) and `pnpm run dev` (tsx).
const PUBLIC_DIR = path.join(process.cwd(), 'src/channels/playground/public');

interface ServerStatus {
  running: boolean;
  url: string | null;
}

export function getPlaygroundStatus(): ServerStatus {
  return { running: server !== null, url: server !== null ? `http://localhost:${PLAYGROUND_PORT}/` : null };
}

function isPrivateIPv4(addr: string): boolean {
  return (
    addr.startsWith('10.') ||
    addr.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(addr) ||
    addr.startsWith('169.254.') ||
    addr === '127.0.0.1'
  );
}

/**
 * Pick a sensible IPv4 to advertise in the magic-link URL when bound to
 * 0.0.0.0. Prefer:
 *   1. PLAYGROUND_PUBLIC_HOST env override (user knows best)
 *   2. First non-loopback, non-private IPv4 (the public address)
 *   3. First non-loopback IPv4 (e.g. private LAN)
 *   4. 'localhost' as last resort
 */
function detectPublicHost(): string {
  const override = process.env.PLAYGROUND_PUBLIC_HOST;
  if (override) return override;

  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
    }
  }
  const publicIp = candidates.find((c) => !isPrivateIPv4(c));
  if (publicIp) return publicIp;
  if (candidates.length > 0) return candidates[0]!;
  return 'localhost';
}

function urlFor(host: string, key: string): string {
  // When bound to 0.0.0.0 we need to advertise an IP browsers can reach.
  // Otherwise (loopback or specific bind), just echo it.
  const display = host === '0.0.0.0' ? detectPublicHost() : host;
  return `http://${display}:${PLAYGROUND_PORT}/auth?key=${encodeURIComponent(key)}`;
}

export async function startPlaygroundServer(
  opts: { userId?: string | null } = {},
): Promise<{ url: string; alreadyRunning: boolean }> {
  if (!PLAYGROUND_ENABLED) {
    throw new Error(
      'PLAYGROUND_ENABLED is not set in env. Add PLAYGROUND_ENABLED=1 to .env or systemd unit and restart.',
    );
  }
  // Mint a fresh single-use magic token bound to the requesting user.
  // Existing sessions from earlier /playground invocations stay valid —
  // we no longer rotate the global cookie out from under other users.
  const token = mintMagicToken(opts.userId ?? null);

  if (server) {
    return { url: urlFor(PLAYGROUND_BIND_HOST, token), alreadyRunning: true };
  }
  if (!getSetupConfig()) {
    throw new Error('Playground adapter setup() was never called — host startup may have failed to register channels.');
  }

  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => handleRequest(req, res));
    httpServer.on('error', (err) => {
      log.error('Playground server error', { err });
      reject(err);
    });
    httpServer.listen(PLAYGROUND_PORT, PLAYGROUND_BIND_HOST, () => {
      server = httpServer;
      startIdleSweep();
      const url = urlFor(PLAYGROUND_BIND_HOST, token);
      log.info('Playground server started', { bind: PLAYGROUND_BIND_HOST, authMode: 'magic-link' });
      resolve({ url, alreadyRunning: false });
    });
  });
}

export async function stopPlaygroundServer(): Promise<void> {
  // Clear all session state defensively even if the listener is gone.
  revokeAllSessions('server-stop');
  stopIdleSweep();
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  log.info('Playground server stopped');
}

// ── Request routing ────────────────────────────────────────────────────────

/**
 * Auth model:
 *   - GET /auth?key=<magic>  — single-shot exchange. Consumes the magic
 *     token (5-min TTL, single-use), mints a new cookie + session row,
 *     redirects to /. Existing sessions are untouched.
 *   - All other endpoints require a cookie matching a row in `sessions`.
 *
 * /playground stop wipes all sessions ("kick everyone"); /playground stop
 * --self only revokes the caller's session via revokeSessionsForUser.
 */
function handleAuthExchange(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== '/auth') return false;
  const submittedKey = url.searchParams.get('key') || '';
  const session = createSessionFromMagicToken(submittedKey);
  if (!session) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Invalid or expired magic link. Re-send /playground on Telegram.\n');
    return true;
  }
  res.writeHead(302, { location: '/', 'set-cookie': formatSessionCookie(session.cookieValue) });
  res.end();
  return true;
}

/**
 * Class-login token redemption — `GET /?token=<class-token>`. Lets
 * students bookmark a per-roster URL minted by `scripts/class-skeleton.ts`
 * and reach the home page without going through Google OAuth.
 *
 * The actual lookup happens in a classroom-installed module that
 * registers a redeemer via `registerClassTokenRedeemer`. Trunk doesn't
 * know about class tokens — if no redeemer is registered, this is a
 * no-op and the request flows through the normal auth check.
 */
function handleClassTokenRedemption(url: URL, res: http.ServerResponse): boolean {
  if (url.pathname !== '/') return false;
  const token = url.searchParams.get('token');
  if (!token) return false;
  const session = redeemClassToken(token);
  if (!session) return false; // not a class token — let normal auth flow handle the request
  res.writeHead(302, { location: '/', 'set-cookie': formatSessionCookie(session.cookieValue) });
  res.end();
  return true;
}

/**
 * "Lost your link?" recovery — students who forgot their class-login
 * URL enter their email and a fresh URL is emailed via the registered
 * recoverer (classroom branch's class-login-tokens.ts, wired to Resend).
 *
 * Anti-enumeration: the response is identical for "email on roster" and
 * "email not on roster" — both return ok:true with a generic message.
 * The recoverer must not throw on miss; it should just log and return.
 *
 * When no recoverer is registered (classroom not installed), the
 * response includes a hint pointing the student at their instructor.
 */
async function handleLostLinkRecover(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = (await readJsonBody(req)) as { email?: unknown };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    send(res, 200, { ok: true, message: "If we have you on file, you'll receive a fresh link shortly." });
    return;
  }
  if (!hasLostLinkRecoverer()) {
    send(res, 200, {
      ok: true,
      message: 'Self-serve recovery is not enabled here. Please contact your instructor for a fresh login link.',
    });
    return;
  }
  // Fire-and-forget the actual recovery: the response stays generic regardless of outcome.
  recoverLostLink(email).catch((err) => log.error('Lost-link recover handler error', { err: String(err) }));
  send(res, 200, { ok: true, message: "If we have you on file, you'll receive a fresh link shortly." });
}

function authenticate(req: http.IncomingMessage): PlaygroundSession | null {
  const submitted = parseCookie(req.headers['cookie'], COOKIE_NAME);
  if (!submitted) return null;
  return getSessionByCookie(submitted);
}

/**
 * GET requests for an HTML page that the user might be visiting cold
 * (no cookie yet) get a friendlier 302 → /login than a stark 401. XHR /
 * asset requests still 401 so client code sees the real error.
 */
function isHtmlPagePath(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/playground' ||
    pathname === '/playground/' ||
    pathname === '/playground/index.html'
  );
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';

  // Public endpoints — no auth required.
  if (method === 'GET' && handleAuthExchange(url, res)) return;
  if (method === 'GET' && handleClassTokenRedemption(url, res)) return;
  if (method === 'GET' && handleOAuthStart(url, res)) return;
  if (method === 'GET' && url.pathname === '/oauth/google/callback') {
    void handleOAuthCallback(url, res).catch((err) => {
      log.error('OAuth callback error', { err });
      if (!res.headersSent) send(res, 500, { error: String(err) });
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/login') {
    return serveStatic(res, 'login.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/login.js') {
    return serveStatic(res, 'login.js', 'application/javascript; charset=utf-8');
  }
  if (method === 'POST' && url.pathname === '/login/recover') {
    void handleLostLinkRecover(req, res).catch((err) => {
      log.error('Lost-link recover error', { err });
      if (!res.headersSent) send(res, 500, { ok: false });
    });
    return;
  }

  const session = authenticate(req);
  if (!session) {
    if (method === 'GET' && isHtmlPagePath(url.pathname)) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Authorization required. Visit /login or send /playground on Telegram for a magic link.\n');
    return;
  }

  // Home page (Phase 2 minimal landing).
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/home.html')) {
    return serveStatic(res, 'home.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/home.js') {
    return serveStatic(res, 'home.js', 'application/javascript; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/home.css') {
    return serveStatic(res, 'home.css', 'text/css; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/api/home/me') {
    return send(res, 200, { userId: session.userId });
  }

  // Workbench static UI moved under /playground/ (was /).
  if (method === 'GET' && (url.pathname === '/playground/' || url.pathname === '/playground/index.html')) {
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/playground/app.js') {
    return serveStatic(res, 'app.js', 'application/javascript; charset=utf-8');
  }
  if (method === 'GET' && url.pathname === '/playground/style.css') {
    return serveStatic(res, 'style.css', 'text/css; charset=utf-8');
  }

  // API
  void route(req, res, url, method, session).catch((err) => {
    log.error('Playground request error', { url: req.url, err });
    if (!res.headersSent) send(res, 500, { error: String(err) });
  });
}

function serveStatic(res: http.ServerResponse, filename: string, contentType: string): void {
  const file = path.join(PUBLIC_DIR, filename);
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, { error: `Not found: ${filename}` });
      return;
    }
    res.writeHead(200, { 'content-type': contentType });
    res.end(data);
  });
}
