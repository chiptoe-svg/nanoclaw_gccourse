---
name: add-dashboard
description: Add a monitoring dashboard to NanoClaw. Installs @nanoco/nanoclaw-dashboard and a v1-schema pusher that sends periodic JSON snapshots.
---

# /add-dashboard — NanoClaw Dashboard (v1 fork)

Adds a local monitoring dashboard showing registered groups, sessions, channels, token usage, context windows, message activity, and real-time logs.

This fork uses NanoClaw's v1 single-file schema (`src/db.ts` + `registered_groups` / `sessions` tables). The dashboard package itself was written for upstream v2 (multi-table `agent_groups` / `messaging_groups` / `users`), so the pusher in this skill maps v1 concepts onto the v2-shaped snapshot the dashboard expects:

- Each `registered_groups` row → one `agent_group` + one `messaging_group` + one wiring (same JID)
- `users`, `members`, `admins`, `destinations` are emitted as empty arrays (v1 has no user table)
- `tokens` and `context_windows` walk `data/sessions/<folder>/.claude/projects/*/*.jsonl`
- `activity` and `messages` come from the v1 `messages` table in `store/messages.db`
- Container running-state comes from `docker ps --filter name=nanoclaw-<folder>-`

## Architecture

```
NanoClaw (pusher)              Dashboard (npm package)
┌──────────┐    POST JSON      ┌──────────────┐
│ collects │ ────────────────→ │ /api/ingest  │
│ DB data  │   every 60s       │ in-memory    │
│ tails    │ ────────────────→ │ /api/logs/   │
│ log file │   every 2s        │   push       │
└──────────┘                   │ serves UI    │
                               └──────────────┘
```

## Steps

### 1. Install the npm package

```bash
npm install @nanoco/nanoclaw-dashboard
```

### 2. Copy the pusher module

Copy the resource file into `src/`:

```
.claude/skills/add-dashboard/resources/dashboard-pusher.ts → src/dashboard-pusher.ts
```

### 3. Wire into `src/index.ts`

Add to the imports near the top:

```typescript
import { startDashboardPusher } from './dashboard-pusher.js';
import { readEnvFile } from './env.js';
```

Add this block in `main()` after the channel-connect loop (after the `if (channels.length === 0)` guard) and before `startSchedulerLoop({...})`:

```typescript
  // Dashboard (optional) — enable with DASHBOARD_ENABLED=1.
  // The dashboard's own bearer-token auth is disabled here because it
  // embeds the token in the HTML (so it isn't real auth anyway). Put the
  // backend behind a reverse proxy with HTTP basic auth instead, and
  // firewall the backend port to localhost.
  const dashboardEnv = readEnvFile(['DASHBOARD_ENABLED', 'DASHBOARD_PORT']);
  const dashboardEnabled =
    (process.env.DASHBOARD_ENABLED || dashboardEnv.DASHBOARD_ENABLED) === '1';
  const dashboardPort = parseInt(
    process.env.DASHBOARD_PORT || dashboardEnv.DASHBOARD_PORT || '3110',
    10,
  );
  if (dashboardEnabled) {
    try {
      const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
      startDashboard({ port: dashboardPort });
      startDashboardPusher({
        port: dashboardPort,
        secret: '',
        intervalMs: 60000,
        getChannels: () => channels,
      });
      logger.info({ port: dashboardPort }, 'Dashboard started');
    } catch (err) {
      logger.error({ err }, 'Dashboard failed to start');
    }
  } else {
    logger.info('Dashboard disabled (set DASHBOARD_ENABLED=1)');
  }
```

### 4. Add environment variables to `.env`

```
DASHBOARD_ENABLED=1
DASHBOARD_PORT=3110
```

### 5. Build and restart

```bash
npm run build
systemctl --user restart nanoclaw   # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### 6. Verify

```bash
curl -s http://localhost:3110/api/status
curl -s http://localhost:3110/api/overview | head -c 400
```

Open `http://localhost:3110/dashboard` in a browser.

## Security: the dashboard package has no real auth

The `@nanoco/nanoclaw-dashboard` package supports a bearer-token "secret" but **renders it directly into the HTML as a `<meta>` tag** so the in-browser JS can use it. That means anyone who can load `/dashboard` gets the token and can call any `/api/*` endpoint — the secret isn't a real authentication boundary. This skill therefore starts the dashboard *without* a secret and assumes the backend port is firewalled to localhost. Choose one of:

- **SSH tunnel (simplest):** keep `DASHBOARD_PORT=3110` blocked from the outside (e.g. `ufw deny 3110/tcp`). Access via `ssh -L 3110:localhost:3110 user@host` and browse `http://localhost:3110/dashboard`. The SSH key is the auth.
- **Reverse proxy with HTTP basic auth:** put Caddy/nginx in front of `127.0.0.1:3110` with basic auth (and HTTPS if you have a domain — Caddy auto-provisions Let's Encrypt). Note: the dashboard's UI overrides `Authorization` to `Bearer <token-from-meta>` for `/api/*` calls, so basic_auth only works cleanly when the backend is started **without** a secret (which is how this skill wires it).
- **Tailscale / VPN:** put the box on a private network and skip the public-port story entirely.

## Dashboard Pages

| Page | Shows | v1 fidelity |
|------|-------|-------------|
| Overview | Stats, token usage, context windows, activity chart | Full |
| Agent Groups | Sessions, wirings, members, admins | Wirings yes; members/admins empty |
| Sessions | Status, container state, context window usage | Full |
| Channels | Live/offline status, messaging groups, sender policies | Full (sender policy stubbed as 'strict') |
| Messages | Per-session inbound/outbound | Full (from v1 messages table) |
| Users | Privilege hierarchy: owner > admin > member | Empty (v1 has no user table) |
| Logs | Real-time log streaming with level filter | Full (tails `logs/nanoclaw.log`) |

## What's not represented

- **Users page** is empty. v1 has `data/sender-allowlist.json` but no user records. If you want this populated, extend `collectUsers()` in `src/dashboard-pusher.ts` to synthesize entries from the allowlist.
- **Members / admins / destinations** on the agent-group detail view are always empty arrays.
- **Sender policy** always reports `strict` (the dashboard doesn't surface allowlist mode/list contents).

## Troubleshooting

- **"No data yet"**: Wait 60s for first push, or check logs for push errors.
- **401 errors**: Verify `DASHBOARD_SECRET` matches in `.env`.
- **Port conflict**: Change `DASHBOARD_PORT` in `.env`.
- **No logs streaming**: Check `logs/nanoclaw.log` exists and is being written to.
- **Container shows "stopped" while it's actively replying**: Container processes are short-lived per-request; the pusher samples once every 60s. This is expected.

## Removal

```bash
npm uninstall @nanoco/nanoclaw-dashboard
rm src/dashboard-pusher.ts
# Remove the dashboard block, `startDashboardPusher` import, and `readEnvFile` import from src/index.ts
# Remove DASHBOARD_SECRET and DASHBOARD_PORT from .env
npm run build
```
