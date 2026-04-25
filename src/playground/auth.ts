/**
 * Password + signed-cookie authentication for the playground.
 *
 * Shared-password design per plan: single password (default "godfrey"),
 * hashed in state.json. On login, server sets a signed cookie
 * `pg_auth=<expiry>.<hmac>` valid for 30 days. Every request verifies
 * the HMAC using state.cookieSecret.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { loadState, sha256 } from './state.js';

const COOKIE_NAME = 'pg_auth';
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(expiry: number, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(String(expiry))
    .digest('hex');
}

export function issueAuthCookie(res: Response): void {
  const state = loadState();
  const expiry = Date.now() + COOKIE_TTL_MS;
  const sig = sign(expiry, state.cookieSecret);
  const value = `${expiry}.${sig}`;
  // Path must match the Caddy reverse-proxy mount. "/playground" is the
  // external path; Express mounts under "/" (handle_path strips prefix).
  // Setting path=/ is safe here since the only thing on localhost:3002 is
  // the playground itself.
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}`,
  );
}

export function clearAuthCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function isAuthenticated(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return false;
  const [expiryStr, sig] = raw.split('.');
  if (!expiryStr || !sig) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const state = loadState();
  const expected = sign(expiry, state.cookieSecret);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function checkPassword(password: string): boolean {
  const state = loadState();
  const provided = sha256(password);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(state.passwordHash),
    );
  } catch {
    return false;
  }
}

/**
 * Middleware: redirect unauthenticated HTML requests to /login, return 401
 * for API requests.
 */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path.startsWith('/static/')
  ) {
    next();
    return;
  }
  // Relative redirect — resolves correctly both direct (/ → /login) and
  // behind Caddy (/playground/ → /playground/login).
  res.redirect('login');
}

export function authCookieFromHeader(
  cookieHeader: string | undefined,
): boolean {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return false;
  const [expiryStr, sig] = raw.split('.');
  if (!expiryStr || !sig) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const state = loadState();
  const expected = sign(expiry, state.cookieSecret);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}
