# Classroom Per-Person Mode — Implementation Plan

> **For agentic workers:** This is an INDEX plan — it sequences the
> 10 Phase-2 build-order items already detailed in
> `plans/master.md` and the linked sub-plans, and adds the
> Phase 1.5 preconditions that shipped 2026-05-15. Each line links
> to the sub-plan with the actual TDD steps. Do NOT duplicate those
> steps here — open the sub-plan when you implement the slice.

**Goal.** Land Phase 2 (per-person classroom mode) as a sequence of
small, independently-shippable slices on top of the Phase 1
shared-classroom MVP.

**Architecture.** Builds on existing primitives: credential-proxy
header-based attribution, class-login-tokens, classroom_roster,
per-group container.json. Adds per-student credential-store tiers
(GWS + provider), magic-link OAuth flows, temp-code fallback, and a
student-facing provider-settings UI. Design rationale + cross-links:
[`docs/superpowers/specs/2026-05-15-classroom-per-person-mode-design.md`](../specs/2026-05-15-classroom-per-person-mode-design.md).

**Tech stack.** Same as trunk — Node host + Bun container + SQLite
session DBs. New work touches `src/gws-token.ts`, `src/credential-
proxy.ts`, `src/channels/playground/public/`, and the
`/add-classroom*` skill family.

---

## Phase 1.5 — Post-class polish (SHIPPED 2026-05-15)

- [x] Per-call `model_call` trace events — codex multi-tool turn
      breakdown — commit `3a10c16`
- [x] Auto-refresh codex catalog from `developers.openai.com` —
      commit `9a1769c`
- [x] Claude support in direct-chat (Anthropic Messages wire
      format) — commit `9400e2a`
- [x] Provider/model sync on `/provider` switch — included in `08ae3d1`
- [x] Chat-tab model dropdown PUTs `active-model` + respawn modal —
      included in `08ae3d1`
- [x] Persona refresh + dad-joke quirk on all student personas —
      `08ae3d1` (scripts/refresh-student-personas.ts)
- [x] Raccoon-unicycle rebrand to "Agent Playground" — commit `6d0ecac`
- [x] `.gitignore` class-roster.csv + remove wire-test-student.ts —
      commit `37dbdad`

---

## Phase 2 — Per-person mode build order

Order matches `plans/master.md` §"Phase 2 — Full classroom capability".

- [ ] **Phase 14 — per-person GWS OAuth.** Per-student Google
      account connection from the playground home tab. UX pattern
      mirrors the existing Telegram "Connect Telegram" card. PIN
      stays as the identity path; this is opt-in resource auth.
      Instructor bearer remains as fallback for anyone who hasn't
      connected. Detail expanded below; legacy text in
      [`plans/gws-mcp.md` §Phase 14](../../../plans/gws-mcp.md).

  **Prereqs (operator, GCP Console — ~5 min, blocking):**
    - [ ] Add redirect URI `http://130.127.162.180:3002/google-auth/callback`
          to the existing OAuth client (identified by `client_id`
          in `~/.config/gws/client_secret.json`).
    - [ ] OAuth consent screen: scopes include `drive`,
          `gmail.modify`, `calendar`. (Drive already there from
          the original install; gmail + calendar are new.)
    - [ ] OAuth consent screen → Test users: add the 10
          `@clemson.edu` student addresses (Restricted scopes
          require allowlisting until app is verified — out of
          scope for 10 students).

  **Tier A — Foundation (no behavior change for unconnected
  students; connected students get per-student token routing
  on existing Drive tools):**
    - [ ] `src/student-google-auth.ts` — writer side: store
          per-student credentials at
          `data/student-google-auth/<sanitized_user_id>/credentials.json`.
          Reader side already exists at `src/student-creds-paths.ts`
          and `src/gws-token.ts:159`. Functions:
          `writeStudentCredentials(userId, tokens)`,
          `hasStudentCredentials(userId)`,
          `loadStudentCredentials(userId): GwsTokens | null`,
          `clearStudentCredentials(userId)` (for revoke flow).
    - [ ] `src/gws-token.ts` — extend `getGoogleAccessTokenForAgentGroup`
          to resolve user_id from `classroom_roster` by
          agent_group_id, then try per-student credentials first
          (refreshing as needed) and fall back to instructor
          bearer on miss. Update returned `principal` field to
          `"student:<user_id>"` or `"instructor"` accordingly so
          per-call attribution surfaces correctly in proxy logs
          and usage aggregation.
    - [ ] `src/channels/playground/api/google-auth.ts` — new
          handler module with two HTTP routes:
          `GET /google-auth/start` — verify session cookie,
          mint a state token bound to the user_id, build
          Google's consent URL with state + scopes
          (drive + gmail.modify + calendar), redirect.
          `GET /google-auth/callback` — verify state, exchange
          authorization code via `gws-auth.ts:exchangeCodeForTokens`,
          call `writeStudentCredentials(userId, tokens)`,
          redirect back to home tab with `?google_connected=1`.
    - [ ] `src/channels/playground/server.ts` — register the two
          new routes (alongside the existing `/oauth/google/*`
          PIN-flow routes which serve a different purpose).
    - [ ] `src/channels/playground/public/tabs/home.js` — new
          "Google" card mirroring `renderTelegramCard`. States:
          *not connected* → "Connect Google" button; *connected*
          → "Connected as `<email>` · Disconnect". Wire button
          to navigate to `/google-auth/start`; render
          `?google_connected=1` query-param as a transient
          success note.
    - [ ] `src/admin-handlers/gauth.ts` (gitignored — `/add-admintools`-
          installed) — new `/gauth` Telegram command. DMs the
          requester a one-click `/google-auth/start` link. Mirror
          of the existing `/playground` magic-link command.
    - [ ] Update `data/class-shared-students.md` — point students
          at the home-tab "Connect Google" card. No mention of
          required connection (it's optional).

  **Tier B — Drive uses per-student token (no new code):**
    - [ ] Verify existing `drive_doc_read_as_markdown` /
          `drive_doc_write_from_markdown` / `sheet_*` /
          `slides_*` tools route through the per-student
          credential when present. Should fall out of Tier A's
          `gws-token.ts` change automatically. Add an
          integration test that exercises both
          (connected-student token, unconnected-student
          fallback) paths.

  **Tier C — Gmail tools:**
    - [ ] Add `gmail_search`, `gmail_read_thread`,
          `gmail_send_draft` to `src/gws-mcp-server.ts`. Draft
          tool returns a draft ID + compose URL; never
          auto-sends (UI-only confirmation).
    - [ ] Add container-side shim in
          `container/agent-runner/src/mcp-tools/gws.ts`.
    - [ ] Add `@googleapis/gmail` to host package.json (pinned).
    - [ ] Smoke test from a connected student's agent.

  **Tier D — Calendar tools:**
    - [ ] Add `calendar_list_events`, `calendar_create_event`,
          `calendar_find_free_slot` to `src/gws-mcp-server.ts`.
    - [ ] Container-side shim + `@googleapis/calendar` pinned.
    - [ ] Smoke test from a connected student's agent.

  **Open question (revisit before Tier C):** auto-send or
  draft-only for Gmail? Drafts-only is the conservative
  default; the agent presents the composed draft + a compose
  URL the student opens to send manually. Auto-send would
  require its own confirmation pattern (approval primitive?).
- [ ] **credential-proxy Phase X.7 — per-student provider OAuth +
      temp-password fallback.** Same shape as the GWS resolver — a
      per-student tier ahead of the instructor pool, with a
      time-bounded `ncl temp-creds grant --user X --hours 24` to
      let students operate on the pool during onboarding.
      Detail: [`plans/credential-proxy-per-call-attribution.md` §X.7](../../../plans/credential-proxy-per-call-attribution.md)
- [ ] **gws-mcp Phase 13.5b — Calendar list/create.** Earns its
      keep once each user has their own calendar. Skipped in
      shared-classroom mode where everyone shares one workspace
      calendar.
      Detail: [`plans/gws-mcp-v2.md` §13.5b](../../../plans/gws-mcp-v2.md)
- [ ] **gws-mcp Phase 13.5c — Drive listing.** Safe to expose once
      per-person mode lands — Google's own auth scopes the result
      to the authenticated user, no per-call ownership filtering
      needed.
      Detail: [`plans/gws-mcp-v2.md` §13.5c](../../../plans/gws-mcp-v2.md)
- [ ] **gws-mcp Phase 13.5d — Gmail search/send.** Same reasoning.
      Detail: [`plans/gws-mcp-v2.md` §13.5d](../../../plans/gws-mcp-v2.md)
- [ ] **classroom Phase 4 — provider settings panel.** Homepage UI
      for students to manage their own provider OAuth + GWS OAuth
      + temp-code redemption. Depends on Phase 14 + X.7.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 4](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 5 — agent export tooling.** Four formats:
      `nanoclaw` / `claude-code` / `codex` / `json`. Endpoint:
      `GET /api/draft/<folder>/export?format=…`.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 5](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 7 — expert system builder + RAG
      strategies.** Pipeline framework + named strategies + UI.
      Cost-economical only after Phase 1 #8 (local-LLM runbook)
      lands.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 7](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 8 — evaluation framework.** Side-by-side
      strategy comparison + LLM-as-judge mode. Depends on Phase 7
      (nothing to evaluate without strategies). The Phase-1.5
      per-call trace events are a precondition — the evaluation
      needs per-call cost breakdowns.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 8](../../../plans/classroom-web-multiuser.md)
- [ ] **classroom Phase 9 — walk-away cloud deploy.** Bundle +
      bootstrap script. Depends on Phase 5 (export) for the
      bundle format.
      Detail: [`plans/classroom-web-multiuser.md` §Phase 9](../../../plans/classroom-web-multiuser.md)

---

## Success criteria

(Same as `plans/master.md` §"Phase 2 success criteria".)

- Student completes own Google OAuth → agent operates as them
  against their own Drive.
- Student opts into per-person provider OAuth; if not, LLM access
  stops gracefully at temp-code expiry.
- Instructor exports an agent in any of four formats and
  re-imports it cleanly.
- A RAG strategy lab runs end-to-end with side-by-side evaluation.
- A class can be bundled and walked away with — one bootstrap
  script on a fresh VPS reproduces the working state.

---

## Execution notes

- Each unchecked slice is its own commit (or small commit cluster)
  with its own test suite — open the sub-plan link above for the
  actual TDD steps.
- The Phase-1.5 trace + catalog + Claude work was discovered
  + shipped DURING the live class, not pre-planned. Captured here
  so the chain of preconditions for Phase 2 #8/9 is explicit.
- Sub-plans MAY have changed since they were last reviewed; if a
  slice doesn't match its sub-plan when you open it, the sub-plan
  is the source of truth — not the bullet here.
