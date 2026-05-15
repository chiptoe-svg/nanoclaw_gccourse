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

- [ ] **Phase 14 — per-person GWS OAuth.** Magic-link flow on the
      student-auth-server, per-user credentials at
      `data/student-google-auth/<id>/`, `/gauth` Telegram command.
      Resolver tier ahead of instructor pool, indexed by
      agent_group_id. Partly blocked on GCP redirect URI
      registration (`project_gcp_oauth_pending` memory).
      Detail: [`plans/gws-mcp.md` §Phase 14](../../../plans/gws-mcp.md)
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
