---
name: add-gws-tool
description: Install the host-side Google Workspace MCP from the gws-mcp branch — relay + V1 Drive Doc tools (drive_doc_read_as_markdown, drive_doc_write_from_markdown). Lightweight per-API @googleapis/* installs, no monolithic googleapis package. Triggers on "add gws tool", "google workspace mcp", "drive doc tool".
---

# Add Google Workspace MCP

Installs the host-side Google Workspace MCP infrastructure into trunk by copying from the `gws-mcp` branch on origin. Lightweight by design: uses per-API `@googleapis/*` packages (~2 MB each) rather than the monolithic `googleapis` package (~200 MB, has crashed hosts on install).

After install, agents get seven tools:

- `drive_doc_read_as_markdown(file_id)` — export a Google Doc to markdown.
- `drive_doc_write_from_markdown(file_id, markdown, ...)` — overwrite (or create-if-missing) a Doc from markdown.
- `sheet_read_range(spreadsheet_id, range)` — read a Google Sheet range (A1 notation) as a 2D string array.
- `sheet_write_range(spreadsheet_id, range, values, value_input_option?)` — write a 2D array into a Sheet range. Defaults to `USER_ENTERED` (formulas evaluate); pass `RAW` to store literally.
- `slides_create_deck(title?, parent_folder_id?)` — create a new Google Slides presentation.
- `slides_append_slide(presentation_id, layout?)` — append a slide (default layout BLANK).
- `slides_replace_text(presentation_id, find, replace_with)` — case-sensitive find/replace across an entire deck.

For Mode A classroom friction (`nanoclaw_owners` ownership tagging + grant/revoke/list tools), layer `/add-classroom-gws` on top. The Mode A check applies to Doc, Sheet, *and* Slides writes since all three are Drive files.

## Prerequisites

- Google OAuth credentials at `~/.config/gws/credentials.json` with at minimum the `drive` and `documents` scopes (most installs that ran the old taylorwilsdon-MCP or `/add-gmail-tool` already have this).
- The credential proxy's `/googleapis/*` route is in trunk by default and uses `src/gws-token.ts` (which stays in trunk to keep credential-proxy whole). No additional credential setup is needed beyond `credentials.json`.

## Install

### Pre-flight (idempotent)

Skip to **Configure** if all of these are in place:

- `src/gws-mcp-relay.ts` exists
- `src/gws-mcp-server.ts` exists
- `src/gws-mcp-tools.ts` exists
- `container/agent-runner/src/mcp-tools/gws.ts` exists
- `@googleapis/drive`, `@googleapis/docs`, `@googleapis/sheets`, and `@googleapis/slides` are in `package.json` dependencies
- `src/index.ts` contains `startGwsMcpRelay`
- `src/config.ts` contains `GWS_MCP_RELAY_PORT`

### 1. Fetch the gws-mcp branch

```bash
git fetch origin gws-mcp
```

### 2. Copy the source files

```bash
git show origin/gws-mcp:src/gws-mcp-relay.ts       > src/gws-mcp-relay.ts
git show origin/gws-mcp:src/gws-mcp-relay.test.ts  > src/gws-mcp-relay.test.ts
git show origin/gws-mcp:src/gws-mcp-server.ts      > src/gws-mcp-server.ts
git show origin/gws-mcp:src/gws-mcp-server.test.ts > src/gws-mcp-server.test.ts
git show origin/gws-mcp:src/gws-mcp-tools.ts       > src/gws-mcp-tools.ts
git show origin/gws-mcp:container/agent-runner/src/mcp-tools/gws.ts      > container/agent-runner/src/mcp-tools/gws.ts
git show origin/gws-mcp:container/agent-runner/src/mcp-tools/gws.test.ts > container/agent-runner/src/mcp-tools/gws.test.ts
```

### 3. Patch `src/config.ts` — add the relay-port export

In `src/config.ts`, find:

```ts
export const PLAYGROUND_PORT = parseInt(process.env.PLAYGROUND_PORT || '3002', 10);
```

Add immediately after it (skip if present):

```ts
export const GWS_MCP_RELAY_PORT = parseInt(process.env.GWS_MCP_RELAY_PORT || '3007', 10);
```

### 4. Patch `src/index.ts` — start/stop the relay

In `src/index.ts`, find the existing `startCredentialProxy` import and add `startGwsMcpRelay` / `stopGwsMcpRelay` alongside it. Add (skip if present):

```ts
import { startGwsMcpRelay, stopGwsMcpRelay } from './gws-mcp-relay.js';
```

Then find the line that starts the credential proxy (`proxyServer = await startCredentialProxy(...)` or similar) and add right after the comment block that begins `// 2b.` or wherever the proxy is started:

```ts
  // 2c. GWS MCP relay — host-side Google Workspace tools. Containers reach
  // it via the same host-gateway pattern as the credential proxy; per-call
  // attribution header authenticates the calling agent group. Loopback only.
  await startGwsMcpRelay(PROXY_BIND_HOST);
```

And in the shutdown handler (near the existing `proxyServer?.close()` line):

```ts
  await stopGwsMcpRelay();
```

### 5. Patch `src/container-runner.ts` — pass GWS_MCP_RELAY_URL to containers

In the import block at the top, add `GWS_MCP_RELAY_PORT` to the `from './config.js'` import (alongside `CREDENTIAL_PROXY_PORT`, etc.).

In `buildContainerArgs`, find the `OPENAI_BASE_URL` env line:

```ts
args.push('-e', `OPENAI_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}/openai/v1`);
```

Add immediately after (skip if present):

```ts
// Google Workspace MCP relay — host-side gateway that the container's
// gws.ts shims forward to. Per-call attribution header set by gws.ts.
args.push('-e', `GWS_MCP_RELAY_URL=http://${CONTAINER_HOST_GATEWAY}:${GWS_MCP_RELAY_PORT}`);
```

### 6. Patch `container/agent-runner/src/mcp-tools/index.ts` — wire the container shim

Append (skip if present):

```ts
import './gws.js';
```

### 7. Install the per-API @googleapis/* deps

```bash
pnpm add @googleapis/drive@20.1.0 @googleapis/docs@9.2.1 @googleapis/sheets@13.0.1 @googleapis/slides@5.0.1
```

### 8. Build + container typecheck + rebuild container image

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

All three must be clean before proceeding.

### 9. Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

### 9b. Linux + ufw: allow docker0 → port 3007

**Skip this step on macOS** (Docker for Mac handles host-side
networking transparently) or on Linux without ufw active.

If the host runs ufw, containers can't reach the GWS relay on
3007 by default. The credential proxy on 3001 usually has an
iptables ACCEPT from an earlier setup step, but 3007 doesn't —
so codex's MCP calls to the relay hang or 502 with no obvious
cause. Add the rule:

```bash
sudo ufw allow in on docker0 to any port 3007 proto tcp
```

This allows traffic from any container on the docker0 bridge to
reach the host's 3007. The proxy is bound to docker0's host IP
(127.x range on Linux, not 0.0.0.0 — see `src/credential-proxy.ts`),
so no public exposure.

Verify:

```bash
sudo ufw status | grep 3007
# → 3007/tcp on docker0      ALLOW IN    Anywhere
```

If you're using Apple Container instead of Docker, replace
`docker0` with whatever bridge interface Apple Container created
(`ip link show | grep -E 'bridge|veth'` to find it).

## Verify

### Check the relay is running

```bash
curl -s http://127.0.0.1:3007/tools
```

Expected response:

```json
{"tools":["drive_doc_read_as_markdown","drive_doc_write_from_markdown","sheet_read_range","sheet_write_range","slides_create_deck","slides_append_slide","slides_replace_text"]}
```

If the relay isn't reachable: the host service isn't running (check `logs/nanoclaw.log`).

### Smoke test from an agent

Send your agent a message like:

> Read the Google Doc with file ID `1abcDEF...` and summarize it.

The agent should call `drive_doc_read_as_markdown` and return the contents. A `404` / `permission denied` means Google says the OAuth account doesn't have access to the file — the relay is working; underlying authorization is blocking.

## Mode A operational caveats

When deploying this to a class against a shared workspace account
(Mode A — instructor signs in once, everyone consumes the bearer):

- **Single point of failure.** Class workspace account lockout =
  whole class down. Use a **dedicated Workspace account** (not your
  personal Gmail), store recovery codes off the host, and keep a
  second workspace-admin email so you can recover from inside the
  same Workspace org.
- **Drive/Calendar/Sheets API quotas are per-OAuth-user.** A busy
  class can hit Drive's 1000-req/100-sec/user limit. Symptoms: 429
  errors in `logs/nanoclaw.log` for `/googleapis/*` paths.

## Troubleshooting

### Relay returns 401 "Missing X-NanoClaw-Agent-Group header"

Container isn't setting the attribution header. Either:

1. Container image is stale — rebuild: `./container/build.sh`.
2. `X_NANOCLAW_AGENT_GROUP` env var isn't being passed — check `src/container-runner.ts` around the env-vars section.

### Relay returns 401 "Unknown agent_group_id"

Container's agent group ID doesn't match anything in the central DB. Verify with `ncl groups list`.

### Tool returns "GWS_MCP_RELAY_URL not set"

Container env doesn't have the relay URL — step 5 above wasn't applied. Patch and rebuild the image.

### `No Google OAuth token available`

Host couldn't load `~/.config/gws/credentials.json` (or the token is expired and refresh failed). Check `logs/nanoclaw.log` for refresh errors. Re-run your OAuth flow and replace `credentials.json`.

## Where this fits in the deploy story

This skill installs the Google Workspace MCP **infrastructure** —
host-side relay + server + container-side tools. It works
standalone for a single-user install (the instructor's own Drive).

For a classroom deploy, layer `/add-classroom-gws` on top: it adds
per-student Drive folders, the shared-classroom ownership-tag
mechanism (`nanoclaw_owners`), and grant/revoke/list tools. The
mode check applies to Docs *and* Sheets *and* Slides writes since
all three are Drive files.

End-to-end guide: [`docs/shared-classroom.md`](../../../docs/shared-classroom.md).
