# Classroom Web Access — multi-user playground, Google login, student home page

## Goal

Make the classroom feature work for a real 25-student course where every
student gets:

- **Web-only access** — no laptop install, no Telegram required. Just a
  URL, a Google sign-in, and a browser tab.
- **A home page** that's the primary surface — playground, settings
  (including optional Telegram link), agent export, and a small
  dashboard. Telegram becomes optional, not the front door.
- **Concurrent playground sessions** — students iterate on persona,
  skills, traces, models, etc. at the same time without kicking each
  other out.
- **Their own Google Workspace** — Doc/Sheet/Drive operations run as
  the student, not the instructor. Boundary enforced by Google, not by
  URL parsing.
- **Agent portability** — export the tweaked agent (persona + skills
  + container config) into formats they can reuse outside class
  (Claude Code project, Codex prompt, generic JSON).
- **Local-LLM ready** — the same setup plays nicely with a locally
  hosted model behind an OpenAI-compatible endpoint (mlx, Ollama,
  LM Studio). Wiring goes through the existing Codex provider path,
  not a new provider.

Today's gap (verified against `src/channels/playground.ts` and the
`add-classroom*` skills):

- Playground HTTP auth uses a **module-level singleton cookie** —
  whoever sent `/playground` last is the only authed user. Fine for
  one operator iterating; broken for 25 concurrent students. The
  classroom-side role gates are already multi-user-aware (they take
  `userId`); the auth front-end was never rebuilt to match.
- Playground access today **requires a Telegram round-trip** to get a
  magic link. Students-without-Telegram is a real constraint for many
  courses.
- All GWS calls today route through the **instructor's OAuth bearer**
  (gws-mcp planned Phase 13/14 — Phase 14 is the per-student fix).

## Architectural shape

Six pieces, sequenced so each lands independently and is testable:

```
1. Multi-user session store        ─► fixes "kicked-out" today
2. Google OAuth + roster + home    ─► fixes "needs Telegram" today;
   page (minimal: login + landing)    establishes the home-page surface
3. Per-student GWS refresh token   ─► fixes "instructor's bearer" today
   (= gws-mcp Phase 14, folded in)
4. Home page expansion             ─► settings, export-tools, dashboard,
                                       picker-role-filter
5. Agent export tooling            ─► persona + skills + container.json
                                       → Claude/Codex/JSON formats
6. Local-LLM via codex provider    ─► OPENAI_BASE_URL → mlx-omni-server
                                       (or Ollama/LM Studio)
```

Pieces 2 and 3 share the same OAuth dance — one Google consent screen,
two outcomes. So we wire them together rather than building Phase 14
as a separate effort.

Pieces 4–6 each stand alone and can be deferred without blocking a
working class deployment. Phase 2 ships a *minimal* home page (login
screen + "Open Playground" button); Phase 4 turns it into a real
dashboard.

## Phase 1 — Multi-user session store

**File:** `src/channels/playground.ts` (rework auth section, ~50 LoC
changed)

**The fix is mechanical**, not architectural:

```ts
// Today (lines 60-69):
let magicToken: string | null = null;
let cookieValue: string | null = null;
let cookieUserId: string | null = null;
let lastActivityAt = 0;

// Rework:
interface PlaygroundSession {
  userId: string | null;       // Telegram or Google identity
  expiresAt: number;            // ms since epoch
  lastActivityAt: number;
}
const sessions = new Map<string /*cookieValue*/, PlaygroundSession>();
const pendingMagicTokens = new Map<string /*token*/, { userId: string | null; expiresAt: number }>();
```

**Behavior changes:**

- `/playground` from Telegram mints a fresh token, adds it to
  `pendingMagicTokens` (5-min TTL), prints URL. Doesn't invalidate
  anyone else's session.
- `/auth?key=<token>` consumes the token, mints a new
  `cookieValue`, inserts a `PlaygroundSession`, sets the cookie.
- `checkAuth(req)` looks up the cookie in `sessions`, validates not
  expired, bumps `lastActivityAt`. Returns the `userId` so handlers
  can pass it into `checkDraftMutation({ userId, ... })`.
- Idle sweep runs on a 1-minute interval — drops sessions past
  `PLAYGROUND_IDLE_MS`, closes their SSE clients.
- `/playground stop` removes ALL sessions (current behavior preserved
  for instructors who want to nuke everyone).
- New: `/playground stop --self` removes only the caller's session.

**SSE tracking** already keys by `draftFolder`; no change needed.
The `cookieUserId` plumbed through `checkDraftMutation` becomes a
per-request lookup from the session map.

**Tests:**

- `playground.test.ts` (new) — two-session round-trip: A authes, B
  authes, both can call API without kicking the other; idle expiry
  drops only the idle session; `/playground stop --self` only removes
  caller.
- Doesn't need a real HTTP server — refactor the auth helpers to be
  testable independently of `http.createServer`.

**Done when:** two browsers, two cookies, both work simultaneously.

---

## Phase 2 — Google OAuth login + roster + minimal home page

Lets students access the playground without Telegram, and establishes
the home-page surface that later phases expand.

**Why Google over email-magic-link:**

- Zero account creation. Students already have school/personal
  Google accounts.
- Email assertion comes from Google, not from the student typing
  their address — no email-spoofing surface.
- Reuses GWS OAuth client (already in
  `~/.config/gws/credentials.json` for installs that have done
  `/add-classroom-gws`). Same client, just adds redirect URIs.
- **Same OAuth refresh token feeds Phase 3** — see below.

**New files:**

- `src/db/migrations/016-classroom-roster.ts` — adds `classroom_roster`
  table:
  ```
  email          TEXT PRIMARY KEY      -- normalized lowercase
  user_id        TEXT NOT NULL         -- e.g. 'class:student_03'
  agent_group_id TEXT                  -- their personal agent group
  added_at       INTEGER NOT NULL
  ```
- `src/db/classroom-roster.ts` — CRUD for above. `lookupByEmail`,
  `addEntry`, `removeEntry`, `listAll`.
- `src/channels/playground/google-oauth.ts` — OAuth handlers.
  `/oauth/google/start` redirects to consent; `/oauth/google/callback`
  exchanges code for tokens, looks up email in roster, mints
  playground session if matched. Reuses `src/gws-auth.ts` for the
  token exchange (already exists).
- `src/channels/playground/login.html` — minimal landing page:
  "Sign in with Google" button + a separate "Have a magic link?"
  link for instructors with Telegram access.
- `src/channels/playground/home.html` (+ `home.js`, `home.css`) —
  minimal post-login landing. Greeting ("Hi Alice"), an "Open
  Playground" button that links to the existing playground UI at
  `/playground/`, and placeholder slots for the Phase 4 settings /
  export / dashboard panels. Routing change: today's `index.html`
  moves to `/playground/index.html`; `/` becomes the home page.

**`/add-classroom` integration:**

- Skeleton script learns a `--roster <file>` flag. The file is a CSV
  with `email,user_id` rows; `class-skeleton.ts` writes those rows
  into the new table during provisioning.
- Re-running `/add-classroom` with the same roster is idempotent
  (UPSERT on email).

**Telegram magic-link path stays.** Instructors and TAs paired via
Telegram still use `/playground`; the Google route is just the
no-Telegram path. Same session store, just two ways to mint a session.

**Done when:** student visits `https://class.example.com/`, clicks
"Sign in with Google," picks their school account, lands in the
playground scoped to their `student_NN` draft. Their email isn't
in the roster → "you're not enrolled in this class" page.

---

## Phase 3 — Per-student GWS refresh token (= gws-mcp Phase 14)

This is the per-student-OAuth piece from `plans/gws-mcp.md` Phase 14,
folded into this plan because it's the same OAuth dance as Phase 2.

**Mechanics:**

- The Google consent screen Phase 2 sends students through requests
  scopes: `openid email` (for identity) + the full GWS scopes the
  course needs (`drive.file`, `documents`, etc.).
- The callback in `google-oauth.ts` already has the refresh token in
  hand from the code exchange. Phase 2 throws it away after pulling
  the email; Phase 3 keeps it.
- Per-student creds path:
  `data/student-google-auth/<sanitized_user_id>/credentials.json`.
  Same shape as `~/.config/gws/credentials.json`, same loader logic
  via `src/gws-auth.ts`.
- `src/credential-proxy.ts` (or the new `src/gws-mcp-relay.ts` from
  the gws-mcp plan) does a per-request lookup keyed on the calling
  agent group's `student_user_id` metadata. Falls back to instructor
  creds if no per-student auth uploaded yet — graceful migration.
- `class-shared-students.md` instructions point students at the
  Google sign-in URL (which now does double duty — playground access
  AND GWS authorization).

**Why this is "free" given Phase 2:**

- The OAuth client is already configured (one-time GCP Console
  redirect-URI add).
- The token exchange already happens in `google-oauth.ts`.
- The only Phase-3-specific work is *persisting* the refresh token
  per-student instead of throwing it away, plus the proxy lookup.

**Done when:** student's agent calls
`drive_doc_read_as_markdown(fileId)` — the call uses *that student's*
refresh token. Reading another student's Doc returns 403 from
*Google*, not from a URL parser.

---

---

## Phase 4 — Home page expansion (settings, dashboard, picker filter)

Phase 2 shipped the home page as a stub. Phase 4 turns it into the
primary surface for the course.

**Routing layout** (after Phase 2 is in place):

```
/                          home page (this phase fills it out)
/login                     Google OAuth + magic-link entry
/oauth/google/callback     OAuth callback
/playground/               existing playground UI (unchanged surface)
/api/...                   existing playground REST + SSE endpoints
/api/home/...              new endpoints for the home-page panels
```

**Panels to add (each is one tab/card on the home page):**

1. **Settings**
   - **Telegram link** — "Connect Telegram" button. Generates a
     pairing token; student `/start`s the bot in Telegram with that
     token; bot replies "linked." After link, agent-side
     notifications (long-running result, request_reauth, etc.) DM
     them in addition to the home-page surface. Without link they
     just see updates in the home-page log/dashboard.
   - **Display name + email** (read-only, from roster).
   - **Provider preference per draft** — already settable inside the
     playground; surfacing here lets students see their current
     choice without entering the playground.
   - **Idle / re-auth controls** — "log out everywhere" button =
     `revokeSessionsForUser(self)`.
2. **Dashboard**
   - Last 24h: messages exchanged, tokens used (from outbound.db
     once it tracks token counts — currently doesn't, so initial
     dashboard shows messages-only and a "tokens coming soon"
     placeholder), errors.
   - Container status: running / idle, last-activity timestamp.
   - Per-channel breakdown if multiple channels are wired (web,
     Telegram).
   - Optionally: GWS quota / Drive folder size if Phase 3 is in.
3. **Export** — see Phase 5; Phase 4 just provides the UI panel that
   calls Phase 5's export endpoints.
4. **Picker-role-filter** — small but real follow-up from
   `agent-playground-v2.md`. The playground picker currently lists
   *every* non-draft agent group; for students, filter to only their
   own. Phase 4 routes the playground link into the home page so the
   filter applies cleanly: `/playground/?onlyMine=1` for student
   sessions; instructors get the full list.

**Files:**

- `src/channels/playground/home/{home.html,home.js,home.css}` —
  three-pane layout, vanilla JS (matches playground UI choices).
- `src/channels/playground/api-home.ts` — `/api/home/dashboard`,
  `/api/home/telegram-link/start`, `/api/home/telegram-link/confirm`,
  `/api/home/sessions/revoke-all`.
- `src/channels/telegram.ts` — `/start <pairing-token>` consumes the
  token, links `telegram:<id>` ↔ `class:<student>`.

**Done when:**

- A logged-in student lands on `/`, sees their dashboard, can link
  Telegram from settings, can click into the playground and only
  see their own draft.
- A logged-in instructor lands on `/`, sees a class-wide dashboard,
  can click into the playground and see all student drafts.

**Hours est:** ~6–8 hr. Mostly UI plumbing; the data is already
in the central DB.

---

## Phase 5 — Agent export tooling

Lets a student or instructor walk away with a portable artifact of
their tweaked agent — for personal use, archival, or porting to a
non-NanoClaw workflow.

**Three export targets, one source of truth:**

The "agent" being exported = the agent-group folder layout NanoClaw
already uses:

```
groups/<folder>/
  CLAUDE.md           ← persona prompt
  CLAUDE.local.md     ← user-editable persona (the playground's
                        primary edit target)
  container.json      ← provider + model + skills + mounts
  skills/             ← per-group skill overlays
```

Three export shapes:

1. **`nanoclaw` (default, lossless)** — tarball or zip of the
   group folder verbatim. Reimport: drop into another NanoClaw
   install's `groups/` directory, run `ncl groups create
   --from-folder <path>`. Round-trips the agent exactly.
2. **`claude-code`** — emit a Claude Code project skeleton:
   `CLAUDE.md` rewritten with the persona content, `.claude/skills/`
   populated from the group's skills overlay. Drops into a fresh
   directory; user runs `claude` from there to use it. Lossy:
   container.json mounts and provider config don't apply outside
   NanoClaw.
3. **`codex`** — emit a Codex-friendly bundle: `AGENTS.md` with the
   persona content, plus a `.codex/skills/` directory if Codex
   honors that path (research before implementing). Lossy in the
   same way as Claude Code export.
4. **`json` (catch-all)** — single JSON file with persona, model,
   provider, skill list, container settings. Useful for "show me
   what my agent looks like" and for any future tooling that wants
   to consume agent specs programmatically.

**API:**

```
GET /api/draft/<folder>/export?format=<nanoclaw|claude-code|codex|json>
```

Returns a `Content-Disposition: attachment` response. The home page's
Export panel renders four "Download as …" buttons.

**Files:**

- `src/agent-export/index.ts` — orchestrator; dispatches by format.
- `src/agent-export/{nanoclaw,claude-code,codex,json}.ts` — one
  formatter per target, ~50–100 LoC each. Pure functions: take the
  group folder path, return a buffer to send.
- `src/channels/playground/home.ts` (Phase 4) — wires the export
  buttons into `GET /api/draft/<folder>/export`.

**Open during Phase 5 — verify the actual format Codex expects.**
The `AGENTS.md` convention is documented in this repo's own
`AGENTS.md`; whether external Codex tooling reads it is the
question. Worst case, drop "codex" target and ship JSON + Claude
Code + nanoclaw.

**Hours est:** ~4–5 hr including format research.

---

## Phase 6 — Local-LLM via Codex provider (mlx / Ollama / LM Studio)

The codex provider in NanoClaw already accepts an
`OPENAI_BASE_URL` override — the credential proxy multiplexes
`/openai/*` to `api.openai.com` by default but can route anywhere. To
serve the class from a local model on the Mac Studio, point that path
at a local OpenAI-compatible server.

**Decision: use the codex provider, not a new "local" provider.**

Reasons:

- The existing path is already audited for header-rewrite
  correctness (`Authorization: Bearer …` injection, key
  substitution).
- Per-agent-group `agent_provider='codex'` already exists in the DB.
- A new provider would mean new container env, new spawn args, new
  proxy routing. Worth avoiding if a config flip can do it.

**What changes — three lines of config + one tiny proxy tweak:**

1. **Run a local OpenAI-compatible server.** mlx-omni-server is
   the natural pick on Apple Silicon (uses MLX under the hood;
   loads GGUF or MLX-native models; exposes `/v1/chat/completions`).
   Ollama works too via its OpenAI-compat layer, with a llama.cpp +
   Metal backend rather than MLX. LM Studio also fine. None of these
   require code changes — they're host-side daemons.
2. **Set `OPENAI_BASE_URL` in `.env`** to the local server, e.g.
   `http://localhost:8080`. The credential proxy reads this on
   startup and uses it as the upstream for `/openai/*` requests.
3. **`OPENAI_API_KEY=local`** (or any string) — local servers
   typically ignore the key. Set something non-empty so SDKs that
   refuse to init without a key still work.
4. **Pick a model** — `OPENAI_MODEL=qwen2.5-coder-32b-instruct`
   (or whatever you've loaded locally). The credential proxy passes
   the model name through unchanged.

**Sizing:**

Out of scope for this plan, but worth noting: 25 students hitting
one local model concurrently will queue. Recommend testing with
batched-inference servers (mlx-omni-server with `--batch` or vLLM if
the model fits) and a smaller model (Qwen 2.5 32B Q4 or 14B for
faster turnaround) before committing the course design to this path.

**Files (almost nothing):**

- `src/credential-proxy.ts` — already supports `OPENAI_BASE_URL`
  override. Verify the request-rewriting handles arbitrary upstream
  hosts (no hardcoded `openai.com` checks). One small audit pass.
- `docs/local-llm.md` (new) — runbook for installing
  mlx-omni-server, configuring `.env`, picking a model.
- `.claude/skills/add-classroom/SKILL.md` — add a note pointing at
  the runbook for instructors who want local-only.

**Hours est:** ~2–3 hr. Mostly the runbook and the proxy audit.
The actual config flip is a handful of `.env` lines.

---

## Hosting / TLS

Out of scope for code, but on the path for any real deployment:

- **Caddy reverse proxy** — single-file install, Let's Encrypt auto-cert,
  one config block:
  ```
  class.example.com {
    reverse_proxy 127.0.0.1:3002
  }
  ```
- **Cloudflare Tunnel** — if the Mac Studio is behind NAT (likely on a
  home/office network). Free, no port-forwarding, automatic TLS.
- **`PLAYGROUND_BIND_HOST=127.0.0.1`** once a reverse proxy is in
  front — keeps the playground off the public interface entirely.

Document one path in the `/add-classroom` skill so instructors don't
end up exposing plain HTTP.

---

## Phased plan

| Phase | What | LoC est. | Hours |
|-------|------|---------:|------:|
| 1 | Multi-user session store | ~80 changed in `playground.ts` + ~150 new test | 4–5 |
| 2 | Google OAuth + roster + minimal home page | ~300 new + migration + skill flag | 7–9 |
| 3 | Per-student GWS refresh token persistence + proxy lookup | ~150 new | 3–4 |
| 4 | Home page expansion (settings, dashboard, picker filter) | ~400 new (UI-heavy) | 6–8 |
| 5 | Agent export (nanoclaw / claude-code / codex / json) | ~250 new | 4–5 |
| 6 | Local-LLM via codex provider (audit + runbook) | ~50 changed + docs | 2–3 |
| Hosting | Document Caddy / Cloudflare Tunnel in skill | docs only | 1 |

Total: ~28–35 hours of focused work for the full set; ~15 hours for the
bare-minimum (Phases 1 + 2 + 3) classroom-deployable cut.

Each phase ends with passing tests and a focused commit.

## Sequencing decision

**Phase 1 is the unblocker** — without it, any classroom deployment
beyond 1 student is broken. Ship Phase 1 first as a trunk fix on
`/add-agent-playground` (channels branch). Anyone using the playground
without classroom benefits from a multi-user fix that's not bundled
with class-specific OAuth.

**Phases 2 + 3 land together** (one OAuth dance, two outcomes) —
splitting them into two PRs would waste the integration work.

**Phase 4 (home page expansion) gates the polish, not the function.**
Phase 2 ships a usable home page (login + "Open Playground" link); a
class CAN run on Phases 1+2+3 alone. Phase 4 is the experience upgrade.

**Phases 5 + 6 are independent and can ship in either order**, after
Phase 4. Phase 5 (export) is a self-contained backend feature.
Phase 6 (local-LLM) is mostly a runbook + small audit; it doesn't
block any other work.

**Recommended cut for "first class":**

- Phases 1 + 2 + 3 + Hosting docs (= MVP) → ~16 hr
- Phase 6 if you're committed to local-LLM for the course → +3 hr
- Phase 4 + 5 as fast-follows in the gap between provisioning and
  first lecture, or after first class as feedback comes in.

## Risks

| Risk | Mitigation |
|------|------------|
| Cookie session map grows unbounded if students don't log out | Idle sweep on 1-min interval (already in scope); cap session count + LRU evict if hit. |
| Google OAuth refresh-token rotation | `gws-auth.ts` already handles rotation; per-student creds.json is rewritten on rotation. |
| Roster CSV becomes the source of truth and drifts from `agent_groups` | `class-skeleton.ts` is the only writer; running it always rebuilds the roster from the same `--names`/`--instructors`/`--tas` it provisions. |
| Student in roster but no agent group | Migration error — surface at `/add-classroom` time, not at student-login time. |
| Instructor's Drive accidentally exposed during the Phase 2-only window (no Phase 3 yet) | Phase 2 + 3 ship together. There IS no Phase-2-only window. |
| TLS cert on Mac Studio public deployment | Caddy/Cloudflare Tunnel setup documented in the classroom skill before first class. |

## Open questions

- **TA/instructor login flow** — they have Telegram, so `/playground`
  magic link still works. Do they want the Google login path too
  (e.g., for use from a phone without Telegram set up)? Probably yes —
  same code path, just check role instead of `student_NN`.
- **Multi-tab per student** — same student opens two tabs. Two
  cookies, two sessions, both authed. Probably fine but worth a
  shrug-and-document moment. v1 had a single-active lock; v2's
  multi-user store removes the *cross-user* lock but leaves the
  *cross-tab* possibility open.
- **Session revocation when removing a student** — delete from roster
  → existing session cookie keeps working until idle expiry. Add
  `revokeSessionsForUser(userId)` for the admin-side remove flow.
- **Codex export format compatibility** — the `AGENTS.md` convention
  is documented in this repo's own `AGENTS.md`; whether external
  Codex tooling reads it is unknown. Verify before Phase 5 ships;
  worst case, drop the codex target and ship JSON + Claude Code +
  nanoclaw.
- **Token-usage tracking in `outbound.db`** — Phase 4's dashboard
  wants per-student token counts. The DB doesn't track them today.
  Either add that to the agent-runner first (small change) or ship
  Phase 4's dashboard with a "tokens coming soon" placeholder.
- **Telegram link UX** — Phase 4 lets a student opt into Telegram
  notifications. What gets pushed to Telegram once linked? Probably:
  request_reauth nudges, long-running task completion, agent-to-agent
  handoff results. List the events explicitly during Phase 4 design.
- **Concurrency on local LLM (Phase 6)** — 25 students hitting one
  Mac Studio. Sizing is empirical; bench mlx-omni-server against
  Qwen 2.5 32B Q4 with `--batch` before committing a course schedule
  around it.

## Out of scope (for this plan)

- gws-mcp Phase 13 (the actual Doc read/write tools) — separate plan
  in `plans/gws-mcp.md`. Phase 3 here just makes Phase 13 safe for
  classroom; Phase 13 is when the tools become useful.
- Apple Container migration — orthogonal, runs on Docker today, can
  swap any time via `/convert-to-apple-container`. The plan works
  regardless of runtime.
- Per-student token-usage / cost dashboard with real numbers — Phase
  4 has a placeholder; the agent-runner change to record tokens is a
  small follow-up plan, not bundled here.
- Course content management (lectures, assignments, grading) — this
  plan delivers the *workbench*; what students DO with it is course
  design, separate from infrastructure.
