# NanoClaw Agent Playground (Single-Agent Version)

## Context

A web UI for iteratively shaping the behavior of **the main agent** in a NanoClaw system. You edit a persona, browse/edit/create skills, chat with a preview of the agent, watch a structured trace of what it does, and when you're happy, apply the changes to the main agent.

**Why this version:** to teach students how to create agents. Single-agent scope means one clear mental model — *edit persona → test → observe → apply*. No template libraries, no team composition, no sandbox lifecycle to learn. Just the core feedback loop of agent design.

**Target system:** VPS-hosted NanoClaw install. UI must be reachable over the public web (not localhost-only).

---

## Core idea

```
┌──────────────────────────────────────────────────────────┐
│  Browser — http://<vps-ip>/playground/                   │
│                                                          │
│  Top bar: [ Draft — unsaved changes ] [ Apply ] [ Reset ]│
│  ┌──────────┬──────────────────┬──────────────────────┐  │
│  │ Chat     │ Execution trace  │ Persona editor       │  │
│  │ + drop   │ (streaming)      │         +            │  │
│  │ files    │                  │ Skill manager (tabs) │  │
│  │          │                  │                      │  │
│  └──────────┴──────────────────┴──────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                       │
              HTTP / WebSocket
                       │
                  Caddy (:80)
         /playground/* → localhost:3002
                       │
┌──────────────────────────────────────────────────────────┐
│  NanoClaw process                                        │
│   ├── NEW: src/playground/ — Express server + UI         │
│   ├── NEW: trace capture in container/agent-runner/      │
│   ├── Playground calls runContainerAgent() directly      │
│   │        (NOT a channel — skips the message loop)      │
│   └── EXISTING: container runner, runtime kernel,        │
│                 scheduler, isolation, Telegram channel   │
└──────────────────────────────────────────────────────────┘
                       │
          Container running the DRAFT agent
          (isolated from the live telegram_main agent)
```

**Two versions of the main agent coexist:**
- `groups/telegram_main/` — the **live** main agent. Keeps running untouched.
- `.nanoclaw/playground/draft/` — a **draft** being edited in the playground. Spawns its own container, has its own scratch workspace, its own sessions.

Playground chat talks to the *draft*, never the live main agent. The **Apply** button copies the draft's persona and any authored skills to `groups/telegram_main/` and `container/skills/` so the next real main-agent run uses the new behavior. Live and draft are completely decoupled until you apply.

> **"Main" in this plan means `groups/telegram_main/`** — the Telegram-facing group that is currently registered as `is_main=1`. If your install uses a different group name for main, substitute it.

---

## Directory layout

```
.nanoclaw/
└── playground/
    ├── library-cache/              # git clone of anthropics/skills, refreshed on demand
    └── draft/
        ├── persona.md              # being edited (target: groups/telegram_main/CLAUDE.md)
        ├── state.json              # dirty flag, last-synced hash, trace level, password hash
        ├── skills/                 # copy-on-write skill scope
        │   └── <skill-name>/
        │       └── SKILL.md        # imported, edited, or newly created
        ├── workspace/
        │   ├── attachments/        # files dropped into chat
        │   └── memory/             # scratch memory, wiped on reset
        └── sessions/
            └── {session-id}/
                ├── meta.json       # started_at, duration, tokens, model
                ├── events.jsonl    # structured trace, append-only
                ├── transcript.md   # human-readable render
                └── files/          # files read or produced this session

groups/
└── telegram_main/
    ├── CLAUDE.md                   # the REAL persona (target of Apply)
    └── ...everything else as-is

container/
└── skills/                         # shared skills; Apply promotes draft/skills/* here
    └── ...
```

---

## UI layout (three panes + top bar)

**Top bar** (always visible):
- Label: "Main Agent Playground — Draft"
- Status badge: `● unsaved changes` / `✓ in sync with main` / `⚠ main changed externally`
- **Apply to Main** button (disabled when no changes)
- **Reset from Main** button (with confirmation)
- Trace verbosity slider: `minimal | summary | full`
- Token counter for the current session

**Left pane — Chat:**
- Message history for the current session
- Markdown rendering (bold, code, lists)
- File drop zone overlay when dragging files onto the pane
- Attached files appear as chips above the input, attach to the next message
- Input box with Send button
- "New session" button (archives current, starts fresh)

**Middle pane — Execution trace:**
- Live WebSocket stream of structured events:
  - `system_prompt` — shows the exact prompt sent
  - `user_message` — what you typed
  - `thinking` — reasoning tokens (if model emits)
  - `tool_call` — name, arguments (collapsible)
  - `tool_result` — output (collapsible, with raw toggle)
  - `file_read` / `file_write` — path, size
  - `skill_invoked` — skill name (when the agent uses the `Skill` tool)
  - `assistant_message` — final reply
  - `session_end` — totals (tokens, duration)
- Each event has a timestamp and type badge
- Collapse-all / expand-all buttons
- Filter chips to hide event types you don't care about

**Right pane — Persona + Skills (tabbed):**

*Tab 1: Persona editor*
- Plain textarea showing `draft/persona.md`
- Save button writes the file; draft is marked dirty
- "Diff vs main" link opens a panel showing the diff between draft and `groups/telegram_main/CLAUDE.md`

*Tab 2: Skills manager*

Three actions for working with skills:

1. **Add from library** — browse the Anthropic skills catalog (`github.com/anthropics/skills`, cloned into `library-cache/` on first use). Click a skill to preview its SKILL.md and any supporting files. When previewing, the playground parses the SKILL.md to detect tools and MCP servers it references, compares against NanoClaw's available tool set, and shows a compatibility badge:
   - ✓ Compatible — all referenced tools are available
   - ⚠ Partial — some referenced tools unavailable (listed)
   - ✗ Incompatible — depends on tools NanoClaw doesn't have (artifacts, computer_use, etc.)
   - "Add to draft" is always enabled but warnings require click-to-confirm. Collision handling: if a skill with that name already exists in `container/skills/` or `draft/skills/`, prompt to rename or overwrite.

2. **Edit existing** — list of skills from both `container/skills/` and `draft/skills/`. Clicking a skill opens its SKILL.md in an editor. First edit of a skill that lives in `container/skills/` triggers copy-on-write into `draft/skills/<name>/`. Supporting files (non-SKILL.md) are shown read-only. Draft skills show an "unsaved" chip until the student clicks Save.

3. **Create new** — modal asking for name and one-line description. Creates `draft/skills/<name>/SKILL.md` with a template and drops the student into the editor.

*Trace highlighting*: as the agent runs, any skill it invokes (via the `Skill` tool in the event stream) gets lit up in the list with an "activated" chip. Students can see which of their enabled skills the agent actually uses versus ignores.

---

## Workflow

### First run
1. User opens `http://<vps-ip>/playground/`
2. Prompted for password (`godfrey`), stored in a signed cookie
3. Playground initializes the draft by copying `groups/telegram_main/CLAUDE.md` → `draft/persona.md`
4. UI loads with status `✓ in sync with main`

### Iterate
1. Edit persona in the right pane, save
2. Browse library, import a skill, or create/edit a skill
3. Send a message in chat
4. Playground calls `runContainerAgent()` directly with a synthetic `RegisteredGroup` pointing at the draft folder (bypassing the channel message loop entirely)
5. Draft container runs with the merged skill view: `container/skills/*` with `draft/skills/*` overlaid on top
6. Events stream into the trace pane as the agent works
7. Agent response appears in chat
8. Drop files into chat → they land in `draft/workspace/attachments/` and attach to the next message
9. Repeat until satisfied

### Apply
1. Click **Apply to Main**
2. Confirmation dialog: "This will overwrite `groups/telegram_main/CLAUDE.md` and promote draft skills into `container/skills/`."
3. Before overwriting, copy current `groups/telegram_main/CLAUDE.md` to `groups/telegram_main/.history/CLAUDE-{timestamp}.md` (automatic backup)
4. On confirm:
   - `draft/persona.md` → `groups/telegram_main/CLAUDE.md`
   - `draft/skills/*` → `container/skills/*` (with collision handling)
5. Status badge changes to `✓ in sync with main`
6. Main agent picks up the new persona on its next invocation (whenever someone messages it via Telegram)

### Reset
1. Click **Reset from Main**
2. Confirmation: "This discards all draft edits."
3. On confirm: copies current `groups/telegram_main/CLAUDE.md` over `draft/persona.md`, wipes `draft/skills/`, optionally wipes `draft/workspace/memory/` and archived sessions

### External changes detection
- On every load, hash `groups/telegram_main/CLAUDE.md` and compare to `state.json`'s last-synced hash
- If different and the draft is also dirty, status badge shows `⚠ main changed externally`
- User has to resolve: either reset from main (losing draft edits) or apply (overwriting the external change)
- No auto-merge

---

## What's new in NanoClaw

| File | Purpose |
|---|---|
| `src/playground/server.ts` | Express server on `127.0.0.1:3002`, routes, WebSocket, password middleware |
| `src/playground/draft.ts` | Draft lifecycle: init, apply, reset, read state, hash comparison |
| `src/playground/skills.ts` | List skills from `container/skills/` + `draft/skills/`, read/write SKILL.md |
| `src/playground/library.ts` | Clone/refresh `anthropics/skills` into `library-cache/`, browse, parse SKILL.md for compatibility |
| `src/playground/run.ts` | Build synthetic RegisteredGroup for draft, call `runContainerAgent()`, pipe results back to chat + WebSocket |
| `src/playground/public/index.html` | 3-pane SPA shell + top bar |
| `src/playground/public/app.js` | Vanilla JS: fetch, WebSocket, DOM updates |
| `src/playground/public/style.css` | Layout + theming |
| `container/agent-runner/src/trace-writer.ts` | Structured event capture to `/workspace/session/events.jsonl` |
| `container/agent-runner/src/index.ts` | Hook trace writer into the Claude Agent SDK event stream (modify) |
| `src/container-runner.ts` | Add draft session mount + merged skill overlay when running draft (modify) |

**Architectural note — not a channel.** The playground does NOT implement NanoClaw's `Channel` interface. It calls `runContainerAgent()` directly with a synthetic `RegisteredGroup` whose folder points at `.nanoclaw/playground/draft/`. This avoids the message loop, per-group queue, and JID routing machinery entirely, which is correct — the draft exists outside NanoClaw's normal inbound/outbound flow.

**REST endpoints:**
- `POST /api/login` — password check, sets cookie
- `GET /api/draft` — current persona, skill list, state, diff vs main, external-change flag
- `PUT /api/draft/persona` — save persona text
- `POST /api/draft/apply` — copy draft → main (persona + skills)
- `POST /api/draft/reset` — copy main → draft, wipe draft skills
- `GET /api/skills` — list skills (merged view of `container/skills/` + `draft/skills/`)
- `GET /api/skills/:name` — return SKILL.md content + supporting file listing
- `PUT /api/skills/:name` — save SKILL.md (copy-on-write into draft if needed)
- `POST /api/skills` — create new skill in draft
- `GET /api/library` — refresh and list library catalog
- `GET /api/library/:category/:name` — preview library skill + compatibility check
- `POST /api/library/:category/:name/import` — copy library skill into draft
- `POST /api/draft/messages` — send a chat message to the draft agent
- `POST /api/draft/attachments` — upload files, attach to next message
- `GET /api/draft/sessions/:id/events` — replay a past session's events

**WebSocket endpoint:**
- `/ws/trace` — live event stream from the draft agent while a session is active

**Tech stack:** vanilla HTML + CSS + JS, no build step. Express for the server. `ws` for WebSocket. Goal: a student can open `app.js` and immediately understand what's happening.

---

## Access model (VPS-hosted)

**Express binds to `127.0.0.1:3002`.** It is never directly exposed.

**Caddy reverse-proxies `/playground/*` to localhost:3002.** Caddy is already running on port 80 serving `/var/www/sites/`. Add a handle block:

```
:80 {
    handle_path /playground/* {
        reverse_proxy localhost:3002
    }
    handle {
        root * /var/www/sites
        file_server browse
    }
}
```

- No new firewall rule needed — port 80 is already open
- WebSocket upgrade works through Caddy automatically
- When a domain is added later, HTTPS is automatic

**Authentication — shared password.** The playground password is `godfrey`. Stored as a hash in `state.json` (or `.env`). On first load, users hit a login page and enter the password. On success, the server sets a signed cookie (HMAC'd with a random secret generated at first startup) and redirects to the UI. Every route checks the cookie. The Express server must also handle being mounted at `/playground/` as a base path (for static assets, API routes, and WebSocket upgrade).

---

## Build phases

### Phase A — Round-trip chat (smallest possible win)
1. Express server bound to `127.0.0.1:3002`
2. Caddy reverse-proxy config for `/playground/*`
3. Password middleware + login page
4. Static `index.html` serving a minimal chat box
5. `run.ts` builds a synthetic RegisteredGroup and calls `runContainerAgent()` directly
6. Draft folder initialized from `groups/telegram_main/CLAUDE.md`
7. Send a message → draft container runs → response appears in UI
8. **Exit test:** you can chat with the draft agent via the browser at `http://<vps-ip>/playground/`.

### Phase B — Trace capture + streaming + latency hiding
1. `container-runner.ts` mounts `draft/sessions/<id>/` → `/workspace/session/` in the draft container
2. `trace-writer.ts` writes `events.jsonl` to `/workspace/session/` inside the container
3. Agent runner pipes Claude Agent SDK events (system prompt, tool_use, tool_result, text, etc.) to the writer
4. Host tails `draft/sessions/<id>/events.jsonl`, broadcasts lines via WebSocket
5. UI trace pane renders events with collapsible tool calls
6. Trace verbosity slider written to `state.json`, respected at container start
7. **Session persistence**: thread the Claude Agent SDK `sessionId` through each chat turn in `run.ts` so the SDK resumes instead of re-initializing every message. Invalidate the session ID when the persona or skills change.
8. **Pre-warm on page load**: when a client connects, spawn a draft container in the background that blocks on stdin waiting for the first message. When the student sends, route to the warm container instead of cold-starting.
9. **Pre-warm on persona/skill save**: debounced 2s after any `PUT /api/draft/persona` or skill save, respawn the warm container with the new config. Track a `warmContainerConfigHash` on the host; on send, use the warm container only if its hash matches current state, otherwise fall back to cold start.
10. **Idle kill**: warm containers die after 60s of no activity to avoid leaked processes.
11. **Exit test:** you can see the system prompt, tool calls, tool results, and final reply for every turn. First message after opening the UI feels instant. Editing the persona and sending a test message feels instant.

### Phase C — Skills manager
1. List skills from both `container/skills/` and `draft/skills/` (merged view)
2. Edit existing: clicking a `container/skills/` skill copies it into `draft/skills/` on first edit (copy-on-write); subsequent edits are in-place
3. Create new: blank template in `draft/skills/<name>/SKILL.md`
4. Library browser: clone `github.com/anthropics/skills` into `library-cache/` on first use, show catalog by category
5. Library preview: parse SKILL.md for referenced tools, compare against NanoClaw's tool set, show compatibility badge
6. Import from library: copy skill directory into `draft/skills/` with collision handling
7. `container-runner.ts` builds the draft container with merged skill view: copy `container/skills/*` then overlay `draft/skills/*`
8. Trace highlighting: watch for `Skill` tool-use events, light up invoked skills in the list
9. **Exit test:** import a library skill, ask the agent to use it, watch it light up in the skills list. Create a new skill, save, ask the agent to use it, see it work.

### Phase D — Apply / Reset / Diff
1. **Apply** button copies `draft/persona.md` → `groups/telegram_main/CLAUDE.md` (with auto-backup to `.history/`) and promotes `draft/skills/*` → `container/skills/*`
2. **Reset** button copies `groups/telegram_main/CLAUDE.md` → `draft/persona.md` and wipes `draft/skills/`
3. External-change detection: hash-compare `groups/telegram_main/CLAUDE.md` on every load
4. Diff view: side-by-side or unified diff of `draft/persona.md` vs `groups/telegram_main/CLAUDE.md`
5. **Exit test:** edit persona in draft → apply → main agent's next Telegram response reflects the change. Reset → draft returns to current main state.

### Phase E — Polish for teaching
1. Token counter in top bar (reads from trace writer totals)
2. File drop zone polish (visual feedback, progress indicators)
3. "New session" button that archives current and starts fresh
4. Download buttons: export persona.md + draft/skills/ as a zip for sharing / grading
5. Import: upload a zip to seed the draft (students can share configs); validates paths to prevent zip-slip
6. **Exit test:** a student can develop, download, and share an agent configuration end-to-end.

**Phases A–D are the MVP.** Phase E is teaching-specific polish.

---

## Tradeoffs and risks

1. **Trace capture hooks into the Claude Agent SDK event stream.** The agent runner currently forwards the SDK's async iterator to stdout via sentinel markers. The trace writer plugs into the same iterator. Non-trivial but not risky — one modification point in `container/agent-runner/src/index.ts`.

2. **Container startup latency.** Cold start on a reasonable VPS is ~2-4 seconds, which adds up across a teaching iteration loop. Mitigated in three layers (Phase B steps 7-10): SDK session persistence within a chat session, pre-warm on page load to hide the first cold start, and pre-warm on persona/skill save to hide the "did my edit work?" cold start. Warm containers expire after 60s idle. The remaining unavoidable cold start is the very first container boot after the playground server restarts.

3. **Apply overwrites main's persona and skills.** If a student applies a broken config and the main agent starts misbehaving, the old state is gone. Mitigation: before Apply, copy `groups/telegram_main/CLAUDE.md` to `groups/telegram_main/.history/CLAUDE-{timestamp}.md` automatically. Skills get no history because they're additive (Apply merges; students can always delete a bad skill from `container/skills/` directly).

4. **Students edit persona.md externally while also using the UI.** The editor's save race could clobber edits. Mitigation: on load, hash the target file. On save, re-hash and compare; if different, warn and show diff before overwriting.

5. **Library skills may depend on tools NanoClaw doesn't have.** Mitigation: parse SKILL.md on library preview, compare referenced tools against NanoClaw's tool set, show a compatibility badge. Students can still import incompatible skills after confirming — they'll learn by seeing the failure.

6. **Public web access.** The UI is reachable from the internet. Mitigation: Caddy reverse-proxies only `/playground/*`, Express binds to `127.0.0.1:3002`, shared password (`godfrey`) enforced by cookie middleware on all routes. Adequate for teaching; not production-grade auth.

7. **events.jsonl grows unbounded** on long sessions. Rotate at a size threshold; oldest events move to `events.jsonl.1`, etc.

8. **Live main agent is still running.** If a Telegram user messages the main agent while the student is also using the Playground, both happen in parallel — the draft and main are fully independent, so no interference. Worth documenting for clarity.

9. **`.nanoclaw/` is a new top-level directory.** Add to `.gitignore`. Per-student state should not be committed.

---

## Verification

- **Phase A:** Open `http://<vps-ip>/playground/`, enter password `godfrey`, type "hello," see the draft agent reply.
- **Phase B:** Same "hello" session shows the full trace: system prompt → user message → tool calls (if any) → assistant message. Reload the page and the past session's trace replays from `events.jsonl`.
- **Phase C:** Browse the Anthropic skills library, preview one, check the compatibility badge, import it. Ask the agent to use it; see the skill light up in the skills list. Create a new skill from scratch, save, ask the agent to use it, see it work.
- **Phase D:** Make any persona change. Click Apply. Confirm. Go to Telegram and message the main agent. The new behavior is in effect. Click Reset. Draft matches main again.
- **Phase E:** Download the persona+skills zip. Import on another student's playground. Their draft now has the same state.

---

## What's NOT in this plan (for a reason)

- **Multiple sandboxes / agent library.** Only one draft, only one main. Keeps the mental model clean for students.
- **Team composition.** Single agent only.
- **Persona template system.** The only template is "current main agent." If students want to start over, they reset from main.
- **Multi-runtime support.** NanoClaw is Claude-only via the Claude Agent SDK. No Codex, no Gemini.
- **Shared context layer.** Not relevant for a teaching install.
- **Scheduled agents.** Main agent runs on demand; teaching doesn't need cron.
- **Fully persistent long-lived container with message routing.** Phase B uses pre-warming and SDK session persistence instead, which hides most of the cold-start pain without requiring a lifecycle refactor of the agent runner.
- **Database / persistence beyond files.** Draft state, sessions, trace, and library cache all live as files. SQLite is used by NanoClaw's core but the Playground adds no new tables.
- **Production-grade auth.** Shared password is adequate for teaching. Don't bolt on OAuth, SSO, or per-student accounts.

---

## Portable to a different system

This plan assumes:
1. A working NanoClaw install with `groups/telegram_main/` (or equivalent) configured and `is_main=1`
2. The Claude Agent SDK runtime available inside containers
3. Node.js 20+ on the host
4. Caddy (or another reverse proxy) on port 80 — see `docs/student-setup-guide.md` for Caddy setup
5. `git` on the host (for cloning the Anthropic skills library)

To install on another machine: copy the new files (`src/playground/`, trace writer additions, `container-runner.ts` modifications), run `npm install` if the playground pulls in Express and `ws`, update `/etc/caddy/Caddyfile` with the `/playground/*` reverse-proxy block, reload Caddy, and restart NanoClaw. The playground auto-initializes the draft on first visit.

No database migrations, no configuration files beyond what NanoClaw already needs, no external dependencies beyond Express, `ws`, and `git`.
