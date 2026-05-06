# Phase 13 — Host-side Google Workspace MCP

A thin Node MCP server, host-side, that exposes a curated set of
Google Workspace operations to NanoClaw agents. Each agent's session
gets a stub MCP entry pointing at this server (via the credential
proxy) so the OAuth refresh token never leaves the host.

This phase fills the gap rclone leaves: rclone makes Drive *files*
look like a normal filesystem (great for bash + Read/Write), but it
can't do Google-application operations — Doc text editing, Sheet
range read/write, Calendar event creation, Gmail send. Phase 13
covers those.

## Why custom Node MCP, not the alternatives

Three alternatives considered + rejected:

- **`@googleworkspace/cli` shelled out as MCP backend.** Adds
  subprocess overhead per call; CLI's flag surface limits what we
  can expose; no benefit over calling the Google APIs directly.
- **Monolith `googleapis` npm package.** Drags the VPS at install
  time (250+ auto-generated API clients + types). Already crashed
  this user's host once.
- **Community Python MCP** (`taylorwilsdon/google_workspace_mcp`).
  Works, but adds a Python runtime and we don't control the
  surface. Acceptable if we want to ship-now without writing code.

**Chosen**: per-API npm packages — `@googleapis/docs`,
`@googleapis/drive`, `@googleapis/sheets`, `@googleapis/calendar`,
`@googleapis/gmail`. Each is small (<2MB), Google-published, and we
write a thin wrapper that exposes only the tools we need.

## Auth model

Reuses `~/.config/gws/credentials.json` (the OAuth refresh token
already minted by the original taylorwilsdon-MCP install). No new
OAuth dance. The same trust model as our existing `class-drive.ts`:

- The refresh token never enters any container.
- The MCP runs on the host with that token.
- Agents call into the MCP via a stub registered in their
  `container.json` `mcpServers`.
- The credential proxy / a dedicated MCP relay forwards the agent's
  JSON-RPC to the host MCP, authenticates the caller by agent
  group ID, applies role-based filters, and returns the result.

## Per-agent scoping (the security boundary)

The proxy authenticates the caller by agent group ID (same
mechanism as Phase 9's per-student Codex auth — structured
placeholder env vars at spawn). The host MCP then enforces role
boundaries:

- **Student** (member of own `student_NN` only): Doc
  read/write within their own Drive folder; calendar of their own
  account if scope allows; **no Gmail send** (or scoped to their
  account only — instructor decides at install).
- **TA** (scoped admin on every student/ta): Doc read/write
  across all class Drive folders; same Calendar rules as students.
- **Instructor** (global admin): full access.
- **Non-class agent groups** (default install): full access — same
  as the host's own OAuth scope.

The proxy looks up the caller's role via the existing
`canAccessAgentGroup` primitive (Phase 12.6 already exposed userId
to gates; same lookup pattern reused here).

## V1 surface (Phase 13.1)

Two tools — exactly what rclone can't do:

- **`drive_doc_read_as_markdown(file_id_or_path)`** — fetches a
  Google Doc, exports as markdown via the Drive `export` endpoint
  (`text/markdown` MIME). Returns the markdown string.
- **`drive_doc_write_from_markdown(file_id_or_path, markdown)`** —
  uploads markdown as a new Google Doc (or replaces an existing
  one), via the Docs API.

Argument shape supports either a Drive file ID or a path within
the agent's accessible Drive folder. Path resolution uses
`@googleapis/drive`'s file search.

These two close the rclone gap completely for class students who
need to read/write course Docs.

## V2 expansions (Phase 13.2+, gated by need)

Each is a separate sub-phase, added only when an actual use case
shows up. Rough order of likely value:

- **`sheet_read_range`** + **`sheet_write_range`** — gradebooks,
  attendance, structured data students collect.
- **`calendar_create_event`** + **`calendar_list_events`** —
  office hours, class schedule, deadlines.
- **`drive_list_files`** with role-scoped folder filter — for cases
  where rclone's view is stale (class just shared a new file and
  rclone hasn't polled yet).
- **`gmail_search`** + **`gmail_send`** — niche; needs careful
  scoping (student-as-themselves, not as instructor).

## Implementation outline

### Files

- `src/gws-mcp-server.ts` — host-side MCP server. Listens on
  loopback, accepts JSON-RPC requests, dispatches to tool handlers.
- `src/gws-mcp-tools.ts` — per-tool implementations. One function
  per exposed tool. Each is ~30 lines: build the API call, invoke
  the right `@googleapis/*` client, format the response.
- `src/gws-mcp-relay.ts` — sits in front of `gws-mcp-server.ts`.
  Authenticates the calling agent group, applies the role filter,
  forwards to the server. Same pattern as the credential proxy.
- `container/agent-runner/src/mcp-tools/gws-stub.ts` — stub MCP the
  agent registers locally; forwards stdio JSON-RPC to the host
  relay over loopback. Mirrors `add-gmail-tool`'s stub pattern but
  goes to our credential proxy instead of OneCLI.
- New deps in `package.json`: `@googleapis/docs`, `@googleapis/drive`.
  Add other per-API packages incrementally.

### Wiring

- Agent group's `container.json` `mcpServers` entry is added by an
  installation skill (Phase 13.4). Format mirrors how channel
  skills wire themselves (e.g., `add-gchat`).
- Per-agent role lookup happens in the relay via the existing
  `canAccessAgentGroup` (no new permission primitive needed).
- Auth refresh: the OAuth refresh token in `~/.config/gws/credentials.json`
  is read at MCP startup and used to mint short-lived access tokens
  on demand. Refresh token rotates if Google rotates it (write back
  to the file). Same mechanism the original taylorwilsdon-MCP used.

### Skills

Phase 13 ships as **one** install skill, `/add-gws-tool` (or
similar). Replaces the deleted `/add-gmail-tool` and `/add-gcal-tool`
skills — same idea (Google MCP for the agent), different mechanism
(native credential proxy, our own MCP rather than OneCLI-managed
gongrzhe/cocal MCPs).

## Substeps

#### 13.0 — Plan ✅

#### 13.1 — Clean up OneCLI-only skills
- [ ] Delete `.claude/skills/add-gmail-tool/`
- [ ] Delete `.claude/skills/add-gcal-tool/`

These don't work on this install (require OneCLI gateway). Phase
13's `/add-gws-tool` supersedes them.

#### 13.2 — Host-side MCP server (V1: Doc read/write)
- [ ] `src/gws-mcp-server.ts` — minimal MCP over JSON-RPC.
- [ ] `src/gws-mcp-tools.ts` — `drive_doc_read_as_markdown`,
      `drive_doc_write_from_markdown`. Use `@googleapis/drive` and
      `@googleapis/docs`.
- [ ] OAuth client setup in `src/gws-auth.ts` — reads
      `~/.config/gws/credentials.json`, exchanges refresh for
      access token, refreshes on 401.

#### 13.3 — Per-agent relay
- [ ] `src/gws-mcp-relay.ts` — JSON-RPC pass-through with role
      check via `canAccessAgentGroup`.
- [ ] Reuses the credential proxy's per-container placeholder
      pattern to identify the caller.

#### 13.4 — Container stub + skill
- [ ] `container/agent-runner/src/mcp-tools/gws-stub.ts` — local
      stub MCP that forwards to the host relay.
- [ ] `.claude/skills/add-gws-tool/` (SKILL.md, REMOVE.md, VERIFY.md).

#### 13.5 — V2 tool surface (separate plan, write when needed)

## Out of scope

- Multi-account OAuth (each agent gets its own Google account).
  Stays single-instructor-OAuth. If a class moves to per-student
  OAuth in the future, that's a different design.
- Gmail send-as-instructor for students. Too easy to abuse;
  requires explicit role allowlist before V2.
