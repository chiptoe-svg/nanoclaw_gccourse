# Upstream-PR Prep — Testing Tracker

Consolidated checklist of work that's code-complete on this fork but
hasn't yet been (a) smoke-tested locally and/or (b) submitted to
upstream `qwibitai/nanoclaw` as a PR. Each section links to the
relevant feature plan; tick the boxes here as items get tested.

This file is the running log. Don't move items to "done" until both
local smoke + upstream PR are landed (or upstream PR is explicitly
declined / deferred for fork-only work).

## Distribution-path note

Anthropic now runs an **official skill marketplace** (submission at
`claude.ai/settings/plugins/submit` or
`platform.claude.com/plugins/submit`). Skills follow the open
**Agent Skills** standard (`agentskills.io`) and ship inside
**plugins** (a package format with `.claude-plugin/plugin.json`).

Two distribution shapes for our skills:

- **Upstream PR** — for skills that should land in trunk
  `qwibitai/nanoclaw` so every install sees them. Best for:
  general-purpose infrastructure improvements (AI-coding CLI picker,
  multi-user playground fix), bug fixes, and core trunk concerns.
- **Plugin / marketplace submission** — for skills that should be
  *opt-in* across all NanoClaw installs (and beyond). Best for:
  classroom-* skills, gws-mcp, agent-playground, walkaway, etc.
  Submitting to the marketplace makes them discoverable to
  non-NanoClaw users running plain Claude Code too.

For each item below, the "Upstream path" line specifies which.

---

## 1. AI-coding-CLI picker (Phases A–F of `plans/ai-coding-cli-pick.md`)

Code state: **✅ shipped on this fork's `main`** (commits `cb75eaf`,
`7719770`, `d6765a2`, `09ce248`, `234de14`, `599cf35`, `48ed9ad`).

Includes registry + Claude Code + Codex + OpenCode adapters,
`--reconfigure-cli` flag, README docs, picker prompt persisted to
`.env` as `NANOCLAW_AI_CODING_CLI`.

**Upstream path:** Trunk PR to `qwibitai/nanoclaw`. This is core
infrastructure (replaces the hardcoded `claude` invocations in
`tz-from-claude.ts`, `claude-handoff.ts`, `claude-assist.ts`); every
install benefits.

### Local smoke (Phase G of the plan)

- [ ] Fresh clone, no AI-coding CLI installed → setup detects, offers
      `setup/install-claude.sh`. Decline → tells user to install one
      and re-run.
- [ ] Only Claude installed → no picker; auto-picks `claude`;
      persists `NANOCLAW_AI_CODING_CLI=claude`.
- [ ] Only Codex installed → no picker; auto-picks `codex`;
      persists `NANOCLAW_AI_CODING_CLI=codex`. Failure handoff invokes
      `codex [PROMPT]`.
- [ ] Only OpenCode installed → no picker; auto-picks `opencode`;
      persists `NANOCLAW_AI_CODING_CLI=opencode`. Failure handoff
      invokes `opencode [PROMPT]`. Headless `tz-from-cli` resolves
      via `opencode run "<prompt>"`.
- [ ] Two-or-more installed (any combination) → picker shows;
      user picks one; persists choice. Re-run setup → picker is
      skipped (already configured).
- [ ] `NANOCLAW_AI_CODING_CLI=mystery` (unknown adapter) → re-prompts
      with warning.
- [ ] `NANOCLAW_AI_CODING_CLI=codex`, then uninstall codex → re-prompts
      on next setup run with "configured CLI not installed" warning.
- [ ] Step-failure mid-setup (force a fail with
      `NANOCLAW_SKIP=force_fail` or similar) → handoff happens via
      chosen CLI; user types `/exit`; setup resumes.
- [ ] `pnpm exec tsx setup/auto.ts --reconfigure-cli` → just shows
      picker, persists, exits 0. Default to current choice (Enter
      keeps current pick).
- [ ] cli-assist diagnose flow: introduce a deliberate fail, accept
      the offer, verify the chosen CLI gets `--tools` opt
      equivalent (`--permission-mode bypassPermissions` for Claude,
      no flag for Codex, `--dangerously-skip-permissions` for
      OpenCode).

### Upstream PR

- [ ] Branch off `upstream/main` (not this fork's `main`, which has
      classroom + admin tools).
- [ ] Cherry-pick the ai-coding-cli-picker commits cleanly. Commits to
      include:
      - framework + adapters (`bb26617`)
      - Phase A: tz-from-cli (`7719770`)
      - Phase B: cli-handoff (`d6765a2`)
      - Phase C: cli-assist (`09ce248`)
      - Phase D: picker (`234de14`)
      - Phase E: README (`599cf35`)
      - Phase F: --reconfigure-cli (`48ed9ad`)
      - OpenCode adapter wiring (`3bad076`) — **optional in
        upstream PR**: the adapter ships in this fork's
        `origin/providers`; upstream may want it bundled into their
        own providers branch instead. Coordinate.
- [ ] PR description: link to plan, list verified smoke matrix from
      above, note the registry-typo fix (`adapter` → `cli` in
      `setup/lib/ai-coding-cli/index.ts:58`).
- [ ] Address review comments.

---

## 2. Agent Playground v2 (`plans/agent-playground-v2.md`)

Code state: **✅ shipped on this fork's `classroom` branch**;
installed locally via `/add-agent-playground` skill (committed in
`.claude/skills/add-agent-playground/SKILL.md` on `main`).

Files: `src/channels/playground.ts` (~700 LoC), `src/agent-builder/`,
UI in `src/channels/playground/public/`, `playground-gate-registry`
extension point.

**Upstream path:** Plugin / marketplace submission (NOT trunk PR).
Reasons: it's a substantial UI subsystem; trunk wants to stay lean;
the plugin format is the natural unit for this. Plus the upstream
project (qwibitai/nanoclaw) has explicitly chosen to keep playground
out of trunk (verified — neither file exists there).

**Known gap blocking deployment:** the singleton-cookie multi-user
issue (Phase 1 of `plans/classroom-web-multiuser.md`). Playground is
single-user today even though classroom infrastructure is multi-user.
Fix lands BEFORE the marketplace submission, not after.

### Local smoke (after Phase 1 multi-user fix lands)

- [ ] `/playground` Telegram command starts the server, prints URL.
- [ ] First magic-link click authenticates, lands on picker.
- [ ] Create draft from a target group → workspace opens.
- [ ] Chat round-trips through real container pipeline.
- [ ] SSE trace events arrive in the log pane.
- [ ] Edit persona → save → next chat reflects change.
- [ ] Provider toggle (claude → codex) → container respawns; next
      message uses new provider.
- [ ] Apply draft → target group updated; session ends.
- [ ] `/playground stop` invalidates all sessions, closes server.
- [ ] **Multi-user (after Phase 1)**: two browsers, two cookies, both
      authed simultaneously, neither kicks the other.
- [ ] Idle expiry: leave a session idle past
      `PLAYGROUND_IDLE_MINUTES` → cookie scrubbed; SSE closes.
- [ ] `PLAYGROUND_BIND_HOST=127.0.0.1` → only loopback; SSH tunnel
      works.

### Marketplace submission

- [ ] **Wait for Phase 1 multi-user fix to land first** —
      submitting a single-user playground would be a regression
      against the plugin's claimed value.
- [ ] Convert `.claude/skills/add-agent-playground/` into a plugin:
      add `.claude-plugin/plugin.json` manifest, move SKILL.md to
      `skills/agent-playground/SKILL.md`. Repackage as a standalone
      plugin (with the source code bundled or fetched from a
      stable URL, not from a fork branch).
- [ ] Submit via `claude.ai/settings/plugins/submit`.
- [ ] Decision-needed: bundle source in plugin (heavier; survives
      fork rename) vs. fetch from `channels` branch at install time
      (smaller; brittle if branch moves). Lean bundle.

---

## 3. Multi-user playground + Google login (`plans/classroom-web-multiuser.md`)

Code state:
- **Phase 1** ✅ shipped on `origin/feat/playground-multiuser` (gccourse).
- **Phase 2 + Phase 3 (slice A)** ✅ shipped on `origin/feat/playground-google-oauth`
  (gccourse), stacked on Phase 1. Slice A is the playground-side OAuth + roster
  + minimal home + per-student GWS *write-side* persistence.
- **Phase 3 slice B** 🛠 promoted to its own plan
  (`plans/credential-proxy-per-call-attribution.md`) — turned out to need
  per-call agent-group attribution that the proxy doesn't have. Earlier
  draft of the multi-user plan claimed this primitive existed; corrected
  in `plans/classroom-web-multiuser.md` Phase 4 prose.
- **`/add-classroom --roster <csv>`** ✅ shipped on
  `origin/feat/classroom-roster-flag` (gccourse, off `origin/classroom`).
  Adds the `--roster` flag + parseRosterCsv helper + class-shared template
  refresh with Google sign-in instructions.
- **Phases 4–9** 🛠 not started.

Live in-browser smoke for Phases 2+3 is gated on registering the redirect
URI in GCP Console — pending the Mac Studio LAN IP being assigned. See
the per-phase smoke sections below.

The 9-phase rebuild that turns the class feature into a real
25-student web deployment. MVP cut for first class is Phases 1+2+3
(~16 hr; ~12 hr now landed via slices, ~4 hr deferred to slice B).

**Upstream path:** Mixed.
- **Phase 1 (multi-user playground fix)**: trunk PR to upstream-of-
  `add-agent-playground` (i.e., the `channels` branch on this fork),
  THEN submit the updated plugin to the marketplace. Or directly to
  upstream qwibitai if they accept the playground inclusion.
- **Phases 2+ (Google OAuth, home page, RAG lab, walkaway)**:
  classroom-specific concerns. Plugin / marketplace submission as
  separate plugins (`/add-classroom-rag`, `/add-walkaway`).

### Local smoke (per phase, as each lands)

Phase 1 — Multi-user session store:
- [x] Two browsers, two cookies, both authed; neither kicks the
      other. — covered by `scripts/smoke-playground-multiuser.ts`
      (12 assertions, in-process HTTP). Live two-browser pass still
      pending real-host run.
- [x] `/playground stop --self` only revokes caller; other sessions
      survive. — `revokeSessionsForUser` covered in unit tests +
      smoke; Telegram-driven path covered in code review only.
- [x] `/playground stop` (no flag) revokes all (preserves current
      behavior). — covered by smoke (`stopPlaygroundServer` step).
- [x] Idle sweep drops only the idle session. — covered by
      `playground.test.ts > sweepIdleSessions`.

Phase 2 — Google OAuth + roster + minimal home page:
- [ ] Student visits `/`, clicks "Sign in with Google", picks
      school account, lands on home page. — **gated on GCP redirect
      URI registration** (see project_gcp_oauth_pending memory).
- [x] Email NOT in roster → "you're not enrolled in this class." —
      covered by `google-oauth.test.ts` + smoke (miss-path returns
      403 with the expected body).
- [ ] Telegram magic-link path still works for instructors. — Phase 1
      smoke covers the magic-link auth flow; live verification pending.
- [ ] `/add-classroom --roster <csv>` provisions roster cleanly. —
      **deferred to slice B (origin/classroom)**.
- [ ] Re-running `/add-classroom` is idempotent (UPSERT). —
      **deferred to slice B**; the underlying `upsertRosterEntry`
      idempotence IS covered by `classroom-roster.test.ts`.

Phase 3 — Per-student GWS refresh token:
- [x] Per-student credentials.json gets written to
      `data/student-google-auth/<sanitized_id>/credentials.json` on
      OAuth callback success. — covered by `google-oauth.test.ts`
      (refresh-token-preservation case included).
- [ ] Student's agent calls `drive_doc_read_as_markdown(fileId)` →
      uses *that student's* token. Reading another student's Doc
      returns 403 from Google. — **deferred to slice B** (needs the
      proxy lookup from `/add-classroom-auth`'s Phase 9).
- [ ] Falls back to instructor's bearer if no per-student auth
      uploaded yet. — **deferred to slice B**.

Phase 4 — Home page expansion:
- [ ] Provider settings panel: dropdown writes
      `agent_groups.agent_provider`; container respawns.
- [ ] Telegram link: `/start <token>` consumes; pairing visible in
      home page settings.
- [ ] Dashboard panel shows messages-in-last-24h (tokens
      placeholder until tracking lands).
- [ ] Picker filter: students see only their draft; instructors see
      all.

Phase 5 — Agent export:
- [ ] Each format produces a downloadable archive.
- [ ] `nanoclaw` format reimports cleanly into another install.
- [ ] `claude-code` format opens correctly with `claude` from a
      fresh directory.
- [ ] `codex` format opens with `codex` (or document the gap).
- [ ] `json` format is parseable.

Phase 6 — Local-LLM via codex:
- [ ] mlx-omni-server running with a Qwen 32B model accepts
      requests routed through credential proxy at
      `OPENAI_BASE_URL=http://localhost:8080`.
- [ ] Concurrency: 5 students hitting it at once → reasonable
      response times (target: <30s/turn under 5-way concurrency).

Phase 7 — Expert system builder + 8 default pipelines:
- [ ] Each pipeline ingests its target content type without crashing.
- [ ] Multimodal-PDF pipeline preserves figures (ingests captions).
- [ ] Video-transcript pipeline produces queryable timestamped
      chunks.
- [ ] Custom-stage drop-in works (auto-discovery from
      `groups/<draft>/knowledge/stages/`).

Phase 8 — Evaluation framework:
- [ ] Side-by-side comparison view renders for 4 sources × 10
      queries.
- [ ] LLM-as-judge mode produces consistent scores (run twice; at
      least 80% agreement).
- [ ] Cost attribution: per-student auth correctly attributes to
      student; class-default to instructor.

Phase 9 — Walk-away:
- [ ] Student runs the bootstrap on a fresh Ubuntu/macOS server.
- [ ] All their state (agent + knowledge + experiments) lands on
      the new server.
- [ ] GWS auth gets re-done correctly (security boundary held).
- [ ] Telegram bot token (theirs, not class) is wired correctly.

### Marketplace submission

- [ ] Phase 1 multi-user fix → submit updated `/add-agent-playground`
      plugin (see #2 above).
- [ ] Bundle Phases 2+3+4 (foundation) into expanded
      `/add-classroom` plugin → marketplace submission.
- [ ] Bundle Phase 5 as `/add-agent-export` plugin → marketplace.
- [ ] Bundle Phases 7+8 as `/add-classroom-rag` plugin →
      marketplace.
- [ ] Bundle Phase 9 as `/add-walkaway` plugin → marketplace.

---

## 4. Class feature foundation (`/add-classroom`, `/add-classroom-gws`, `/add-classroom-auth`)

Code state: **✅ shipped on this fork's `classroom` branch**;
installed via three skills.

**Upstream path:** Plugin / marketplace submission. Same rationale
as agent playground — substantial layered functionality, fits the
plugin format.

### Local smoke

- [ ] Fresh `/add-classroom` install with `--instructors`, `--tas`,
      `--names` provisions cleanly.
- [ ] Each role tier gets the expected role-grant on pair (verify
      via `ncl roles list`).
- [ ] `/add-classroom-gws` creates a Drive folder per student,
      shares correctly, mounts at `/workspace/drive/`.
- [ ] `/add-classroom-auth` magic-link upload works; `/login`
      command re-issues.
- [ ] Wiki commits attributed to real student names + emails.
- [ ] Class-shared markdown propagates to all student folders.

(Many of these were probably smoke-tested ad-hoc during the
classroom feature build but not as a unified runbook. Treat this
section as catch-up validation before marketplace submission.)

### Marketplace submission

- [ ] Convert each skill into a plugin (one plugin per skill, or a
      single classroom plugin with namespaced sub-skills —
      design decision; lean per-plugin for visibility).
- [ ] Submit each via `claude.ai/settings/plugins/submit`.

---

## 5. Class wiki (`/add-classroom-wiki`)

Code state: **🛠 not yet built** — sketched in
`plans/classroom-web-multiuser.md` "Naturally layered skills"
section. Composes `/add-karpathy-llm-wiki` + `/add-classroom`.

**Upstream path:** Plugin / marketplace submission. Sibling to the
existing classroom-* plugins.

Smoke tests + submission deferred until the skill itself ships.
Listed here so it's tracked.

---

## 6. gws-mcp Phase 13 (Doc read/write tools — `plans/gws-mcp.md`)

Code state: **🛠 plan exists, Phase 13.0 done; 13.1–13.4 unbuilt**.

Phase 14 (per-student OAuth) is folded into
`plans/classroom-web-multiuser.md` Phase 3.

**Upstream path:** Plugin / marketplace submission as
`/add-gws-tool` (per the plan's Phase 13.4).

Smoke tests + submission deferred until the skill ships.

---

## 7. Gemini — two separate tracks

**These are different work items often conflated. Track them apart.**

### 7a. Gemini agent-provider (upstream PR #2136 — NOT YET MERGED)

Code state: **🟡 upstream PR open, not merged**.

`feat(providers): add Google Gemini provider support` —
qwibitai/nanoclaw#2136 (head branch
`feat/add-gemini-provider`, target `providers`). Adds Gemini as a
first-class agent provider parallel to OpenAI Codex; uses Google
Gemini CLI's `app-server` (JSON-RPC over stdio) as the backend.
Supports MCP tools, session resume, native compaction, CLAUDE.md
expansion.

**Action items:**
- [ ] Watch upstream for merge. Bookmark
      https://github.com/qwibitai/nanoclaw/pull/2136
- [ ] When merged, the new files will live on `upstream/providers`
      alongside the OpenCode files this fork's `/add-opencode` skill
      already pulls. Update our `origin/providers` (rebase or merge
      from upstream) to bring them in.
- [ ] Create `/add-gemini` skill (mirror of `/add-opencode`) that
      pulls the Gemini provider files from `origin/providers`.
- [ ] Test as an agent backend (not setup-helper — see 7b).

**Note**: PRs #2135 and #2137 (CLOSED) appear to be earlier
iterations of the same work. #2136 is the current one.

### 7b. Gemini AI-coding CLI adapter (independent of 7a)

Code state: **🛠 not started, optional**.

This is the *setup-helper CLI* track — analogous to the OpenCode
AI-coding CLI adapter we just shipped (`3bad076`). Independent of the
agent-provider work above: 7a uses Gemini for runtime agent calls;
7b uses Gemini CLI to debug failed setup steps. An operator could
have either, both, or neither.

Google's `gemini-cli` is a credible fourth AI-coding CLI candidate
alongside Claude Code, Codex, and OpenCode. Free tier (60 rpm,
1k rpd) with personal Google accounts plus enterprise tier via
Vertex AI.

**Pre-implementation work needed:**
- [ ] Verify Gemini CLI surface: does it have a non-interactive
      print mode? Tools-on flag for headless? Interactive prompt
      passthrough? (Same three questions we answered for opencode.)
- [ ] If yes to all three, write the adapter (~50 LoC) and ship to
      `origin/providers` + register in `setup/lib/ai-coding-cli/index.ts`.

**Upstream path:** Same shape as opencode — adapter file lives on
`origin/providers`, skill on main; potential trunk PR if adapter is
small and uncontroversial. Could ship as part of `/add-gemini`
(7a's skill) once that exists, parallel to how OpenCode's AI-coding CLI
adapter ships through `/add-opencode`.

---

## Cross-cutting upstream-PR strategy

When the time comes to submit upstream:

1. **Branch from `upstream/main` cleanly** — not from this fork's
   `main`, which has classroom + admin tools mixed in.
2. **One PR per logical unit.** Don't bundle ai-coding-cli + classroom
   + agent-playground in a single PR; reviewers will reject for
   scope.
3. **Recommended ordering:**
   1. AI-coding-CLI picker (broadest applicability, smallest review
      surface, no controversial decisions)
   2. Multi-user playground fix (when it lands; bug fix character)
   3. Anything else considered for trunk inclusion
4. **Plugin submissions are independent** — don't gate them on
   trunk PRs. Marketplace approval and trunk inclusion are
   separate paths.
5. **CONTRIBUTING.md compliance** — verify each PR meets the
   project's contribution guidelines (commit messages, test
   coverage, doc updates). The fork has accumulated some patterns
   (skill-extraction philosophy) that aren't necessarily
   upstream's — strip those out before submitting.

## Open questions

- **Should we maintain `origin/providers` long-term?** The branch
  exists now (created during opencode adapter work) for skill-fetch
  purposes. Once submitted to marketplace as plugins, the
  fetch-from-branch model goes away. Keep it for skill-route users
  vs. retire it post-marketplace?
- **Plugin packaging — bundle vs. fetch?** Plugins can either embed
  source code directly or fetch from a URL at install. Bundle is
  more reproducible; fetch is smaller. Decide per-plugin.
- **Trust + review path for the marketplace**: Anthropic likely has
  some review process. Note any rejected submissions here so we
  learn the rules.
