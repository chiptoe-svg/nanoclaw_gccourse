---
name: add-gws-tool
description: Wire the host-side Google Workspace MCP relay so agents can read and write Google Docs as markdown. Replaces the deleted /add-gmail-tool and /add-gcal-tool skills (which required OneCLI). Triggers on "add gws tool", "google workspace mcp", "drive doc tool".
---

# Add Google Workspace MCP

Wires up Phase 13 Google Workspace tools (Drive / Docs as markdown today; Sheets / Calendar / Gmail as separate sub-phases when needed). The tools live in `container/agent-runner/src/mcp-tools/gws.ts` and forward every call to `src/gws-mcp-relay.ts` on the host. The relay reads `X-NanoClaw-Agent-Group`, applies role-based access checks via `canAccessAgentGroup`, and resolves an OAuth bearer per-agent (instructor's token today; per-student tokens once Phase 14 lands).

Two tools surface to every agent:

- `drive_doc_read_as_markdown(file_id)` — export a Google Doc to markdown.
- `drive_doc_write_from_markdown(file_id, markdown, ...)` — overwrite (or create-if-missing) a Doc from markdown.

The relay starts with the host on `pnpm run dev` / `systemctl --user start nanoclaw`, so there's no separate service to manage.

## Phase 1: Pre-flight

### Check the relay is running

```bash
curl -s http://127.0.0.1:3007/tools | head
```

Expected response:

```json
{"tools":["drive_doc_read_as_markdown","drive_doc_write_from_markdown"]}
```

If the relay isn't reachable: the host service isn't running (`systemctl --user status nanoclaw` or check `logs/nanoclaw.log`).

### Check Google OAuth credentials exist

The host reads its OAuth refresh token from `~/.config/gws/credentials.json`. Verify:

```bash
ls -l ~/.config/gws/credentials.json
```

If the file is missing the relay will return `{ ok: false, error: "No Google OAuth token available — ..." }` on every call. Three ways to obtain it:

1. **Existing taylorwilsdon Google Workspace MCP install** — the file is already there from that setup. Reuse as-is.
2. **Phase 14 magic-link flow** — not yet implemented. Tracked in `plans/gws-mcp.md`.
3. **Manual** — populate `credentials.json` with `client_id`, `client_secret`, and `refresh_token` matching the scopes in `src/gws-auth.ts` (`DEFAULT_GWS_SCOPES`). Mint the refresh token by running an OAuth consent flow against your Google Cloud project's OAuth client and exchanging the resulting code for tokens.

Once obtained, smoke-test:

```bash
pnpm exec tsx -e "import('./src/gws-token.js').then(m => m.getGoogleAccessTokenForAgentGroup(null).then(t => console.log(t ? 'ok' : 'no token')))"
```

## Phase 2: Smoke test from an agent

Send your agent a message like:

> Read the Google Doc with file ID `1abcDEF...` and summarize it.

The agent should call `drive_doc_read_as_markdown` and return the contents. If you see a `404` or `permission denied` error, that's Google's response — the OAuth account doesn't have access to the file. The relay is working; it's the underlying authorization that's blocking.

## Troubleshooting

### Relay returns 401 "Missing X-NanoClaw-Agent-Group header"

The container isn't setting the attribution header. Two likely causes:
1. The container image is stale (built before `feat/credential-proxy-attribution` landed). Rebuild: `./container/build.sh`.
2. `X_NANOCLAW_AGENT_GROUP` env var isn't being passed — check `src/container-runner.ts` around line 489.

### Relay returns 401 "Unknown agent_group_id"

The container's agent group ID doesn't match anything in the central DB. Either the DB is stale or the group was deleted. Verify with `ncl groups list`.

### Tool returns "GWS_MCP_RELAY_URL not set"

The container env doesn't have the relay URL. Rebuild the image (`./container/build.sh`) and restart the service. Verify with `docker inspect <container> | grep GWS_MCP_RELAY_URL`.

### `No Google OAuth token available`

The host couldn't load `~/.config/gws/credentials.json` (or the token is expired and refresh failed). Check `logs/nanoclaw.log` for refresh errors. Typical fix: re-run OAuth consent and replace `credentials.json` (see Phase 1 above).
