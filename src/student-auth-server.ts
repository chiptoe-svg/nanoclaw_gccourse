/**
 * Magic-link HTTP server for per-student Codex OAuth uploads.
 *
 * Always-on (lazy-started on first token issuance, but stays up). Two
 * routes:
 *   GET  /student-auth?t=<token>          — drag-drop upload page
 *   POST /student-auth/upload?t=<token>   — JSON body { authJson: "..." }
 *
 * Tokens are single-use, 30-min TTL, in-memory only (server restart
 * invalidates all pending tokens — fine, students can /login again).
 *
 * Security model: the token is the only proof that the bearer is the
 * authorized student. Telegram delivered the token over the bot DM, so
 * compromise requires control of the student's Telegram account or
 * MITM on the magic-link URL — same trust model as the playground's
 * magic link.
 *
 * Out of scope for this server: rendering anything other than the
 * upload page. No general-purpose routes; if a request doesn't match
 * one of the two endpoints, return 404.
 */
import crypto from 'crypto';
import http from 'http';

import { NANOCLAW_PUBLIC_URL, STUDENT_AUTH_BIND_HOST, STUDENT_AUTH_PORT } from './config.js';
import { log } from './log.js';
import { storeStudentAuth } from './student-auth.js';

const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_BYTES = 24; // 192 bits — well past brute-force territory

interface PendingToken {
  userId: string;
  createdAt: number;
}

const tokens = new Map<string, PendingToken>();
let server: http.Server | null = null;

/**
 * Issue a fresh magic-link token for a user. Idempotent in spirit —
 * each call mints a new token; the previous one stays valid until its
 * TTL expires (so a student who lost the DM can re-issue without us
 * needing to invalidate the prior link).
 */
export function issueAuthToken(userId: string): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('userId is required');
  }
  ensureServer();
  pruneExpired();
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  tokens.set(token, { userId, createdAt: Date.now() });
  log.info('student-auth token issued', { userId });
  return token;
}

/**
 * Build the public-facing magic-link URL for a token. Returns null if
 * NANOCLAW_PUBLIC_URL isn't configured — the caller should then surface
 * a "ask your instructor for the link" message rather than render a
 * URL that won't work from the student's phone.
 */
export function buildAuthUrl(token: string): string | null {
  if (!NANOCLAW_PUBLIC_URL) return null;
  const base = NANOCLAW_PUBLIC_URL.replace(/\/+$/, '');
  return `${base}/student-auth?t=${encodeURIComponent(token)}`;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (now - entry.createdAt > TOKEN_TTL_MS) tokens.delete(token);
  }
}

function consumeToken(token: string): string | null {
  pruneExpired();
  const entry = tokens.get(token);
  if (!entry) return null;
  tokens.delete(token);
  return entry.userId;
}

function lookupTokenForView(token: string): string | null {
  pruneExpired();
  return tokens.get(token)?.userId ?? null;
}

const UPLOAD_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Connect your ChatGPT account</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-width: 640px; margin: 0 auto; padding: 24px; line-height: 1.5;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .lede { color: #666; margin-top: 0; }
  ol { padding-left: 1.2rem; }
  ol li { margin-bottom: 0.5rem; }
  code {
    background: rgba(127, 127, 127, 0.15);
    padding: 1px 6px; border-radius: 4px;
    font-size: 0.92em;
  }
  #drop {
    border: 2px dashed #888; border-radius: 8px;
    padding: 28px 16px; text-align: center; margin-top: 16px;
    cursor: pointer; transition: background 0.15s, border-color 0.15s;
  }
  #drop.hover { border-color: #2563eb; background: rgba(37, 99, 235, 0.08); }
  textarea {
    width: 100%; min-height: 120px;
    font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 0.85rem;
    margin-top: 12px; padding: 8px; border-radius: 6px;
    border: 1px solid #888; background: rgba(127, 127, 127, 0.05);
  }
  button {
    margin-top: 12px; padding: 10px 18px; font-size: 1rem;
    background: #2563eb; color: white; border: 0; border-radius: 6px;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  #status { margin-top: 16px; min-height: 1.5em; }
  .ok { color: #16a34a; }
  .err { color: #dc2626; }
</style>
</head>
<body>
<h1>Connect your ChatGPT account</h1>
<p class="lede">One-time setup so the class bot uses your subscription instead of your instructor's.</p>

<ol>
  <li>Install Codex on your laptop:
    <code>brew install codex</code> (macOS) or
    <code>npm i -g @openai/codex</code> (anywhere).
  </li>
  <li>Run <code>codex login</code> in your terminal. A browser window
    opens — sign in with the ChatGPT account your school provided.
  </li>
  <li>Find <code>~/.codex/auth.json</code> on your laptop. Drag it
    here, or paste its contents into the box below.
  </li>
</ol>

<div id="drop">📂 Drop your <code>auth.json</code> here</div>
<textarea id="paste" placeholder="…or paste the contents of auth.json"></textarea>
<button id="submit" disabled>Connect</button>
<div id="status"></div>

<script>
(function () {
  const token = new URL(location.href).searchParams.get('t') || '';
  const drop = document.getElementById('drop');
  const paste = document.getElementById('paste');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');
  let payload = '';

  function setPayload(text) {
    payload = (text || '').trim();
    submit.disabled = !payload;
  }

  paste.addEventListener('input', () => setPayload(paste.value));

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('hover');
    const file = e.dataTransfer.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { paste.value = reader.result; setPayload(reader.result); };
    reader.readAsText(file);
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true; status.textContent = 'Uploading…'; status.className = '';
    try {
      const res = await fetch('/student-auth/upload?t=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authJson: payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        status.textContent = '✅ Connected. You can close this tab and go back to the bot.';
        status.className = 'ok';
      } else {
        status.textContent = '❌ ' + (body.error || ('HTTP ' + res.status));
        status.className = 'err';
        submit.disabled = false;
      }
    } catch (err) {
      status.textContent = '❌ ' + err.message;
      status.className = 'err';
      submit.disabled = false;
    }
  });
})();
</script>
</body>
</html>
`;

const TOKEN_INVALID_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Link expired</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:24px;line-height:1.5;text-align:center}</style>
</head><body>
<h1>Link expired</h1>
<p>This auth link is no longer valid. DM the bot <code>/login</code> to get a fresh one.</p>
</body></html>
`;

function send(res: http.ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  send(res, status, 'application/json', JSON.stringify(payload));
}

async function readBody(req: http.IncomingMessage, max = 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) throw new Error('Body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function ensureServer(): void {
  if (server) return;

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('t') || '';

    if (req.method === 'GET' && url.pathname === '/student-auth') {
      if (!token || !lookupTokenForView(token)) {
        return send(res, 404, 'text/html; charset=utf-8', TOKEN_INVALID_HTML);
      }
      return send(res, 200, 'text/html; charset=utf-8', UPLOAD_PAGE_HTML);
    }

    if (req.method === 'POST' && url.pathname === '/student-auth/upload') {
      const userId = consumeToken(token);
      if (!userId) {
        return sendJson(res, 401, { error: 'Token invalid or expired. Request a new link via /login.' });
      }
      let body: { authJson?: unknown };
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw) as { authJson?: unknown };
      } catch {
        return sendJson(res, 400, { error: 'Body must be JSON.' });
      }
      const authText = typeof body.authJson === 'string' ? body.authJson : '';
      if (!authText) {
        return sendJson(res, 400, { error: 'authJson is required.' });
      }
      try {
        storeStudentAuth(userId, authText);
        log.info('student-auth uploaded', { userId });
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Storage failed.';
        return sendJson(res, 400, { error: message });
      }
    }

    send(res, 404, 'text/plain', 'Not found');
  });

  server.listen(STUDENT_AUTH_PORT, STUDENT_AUTH_BIND_HOST, () => {
    log.info('Student-auth server started', {
      port: STUDENT_AUTH_PORT,
      bind: STUDENT_AUTH_BIND_HOST,
      publicUrl: NANOCLAW_PUBLIC_URL || '(unset — magic links not deliverable)',
    });
  });
}

/** Test/shutdown hook. */
export async function stopStudentAuthServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    tokens.clear();
    log.info('Student-auth server stopped');
  }
}

/** Test hook — clear in-memory token registry without stopping the server. */
export function _resetTokensForTest(): void {
  tokens.clear();
}

/** Test hook — return the OS-assigned port when STUDENT_AUTH_PORT was 0. */
export function _getBoundPortForTest(): number | null {
  const addr = server?.address();
  if (typeof addr === 'object' && addr) return addr.port;
  return null;
}

/** Test hook — wait for the server to be listening (lazy boot is async). */
export async function _waitForListeningForTest(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (_getBoundPortForTest() != null) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Server did not begin listening within timeout');
}
