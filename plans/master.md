# NanoClaw gccourse — master plan

Single entry point for what to do next on this fork. The detailed
designs live in the sub-plans referenced inline; this file is the
sequencing layer.

## What's shipped

| Subsystem | Where it landed |
|---|---|
| AI-coding-CLI picker (Phases A–F) | `main`, commits per `plans/ai-coding-cli-pick.md` |
| Agent Playground v2 | installed via `/add-agent-playground`, declared SHIPPED in `plans/agent-playground-v2.md` |
| Class feature foundation (`/add-classroom*` skills) | `origin/classroom` branch |
| Multi-user playground session store (Phase 1) | `main` (merge `7e5398d`) |
| Google OAuth + roster + minimal home (Phase 2) | `main` (merge `f7d1fa8`) |
| Per-student GWS refresh-token persistence — write side (Phase 3 slice A) | `main` (same merge) |
| `--roster <csv>` flag in `class-skeleton.ts` (slice B CSV import) | `origin/classroom` (merge `63d87c7`) |
| Playground module split (Tier A audit refactor) | `main` (~auth-store / sse / server / api-routes / adapter / http-helpers / ttl-map split) |
| `setup-cli` → `ai-coding-cli` rename | `main` (merge `af34009`) |
| Credential-proxy per-call attribution (Tier 1 keystone) | `main` (merge `4161e55`) |
| Per-student GWS read in proxy (Phase 3 slice B) | `main` (folded into the keystone merge) |
| GWS MCP server + relay — Phase 13.2 + 13.3 | `main` (same merge as keystone) |
| GWS MCP container → relay wiring + `/add-gws-tool` skill — Phase 13.4 | `main` (commit `cecfb36`) |
| Phase 13.5 V2 surface — mode-aware sub-plan | `main` (commits `e8aede2` + `bb337d9`); no tools landed yet |

Latest tracker: `plans/upstream-pr-prep.md` for the per-item PR-readiness state.

## Sub-plans (active)

| Plan | Subject | Status |
|---|---|---|
| [classroom-web-multiuser.md](classroom-web-multiuser.md) | Phases 4–9 of the class web rebuild | Phases 1–3 shipped; 4–9 pending |
| [credential-proxy-per-call-attribution.md](credential-proxy-per-call-attribution.md) | Per-call agent-group attribution in the credential proxy | ✅ shipped (X.1–X.3 + X.6); X.4 (per-provider OAuth resolvers) deferred to Phase 4; X.5 (observability log) deferred |
| [gws-mcp.md](gws-mcp.md) | Host-side Google Workspace MCP (Doc/Drive/Sheet/Calendar/Gmail tools) | 13.0–13.4 done; 13.5 sub-plan written ([gws-mcp-v2.md](gws-mcp-v2.md)); Phase 14 (per-student OAuth) pending |
| [gws-mcp-v2.md](gws-mcp-v2.md) | V2 tool surface — sheets / calendar / drive-listing / gmail, mode-aware | Sub-plan only; each sub-phase landed when a real use case appears |
| [ai-coding-cli-pick.md](ai-coding-cli-pick.md) | AI-coding-CLI picker | A–F shipped; only Phase G (smoke matrix) left |

## Sub-plans (archived as historical)

`agent-playground-v2.md` (self-marked SHIPPED). Kept as design-record;
not on the active worklist.

## Order of work

The dependency graph picks the order — items land when their blockers
clear. Tier numbers are coarse buckets; within a tier, items can run
in any sequence (or in parallel via worktrees).

### Tier 1 — keystone infrastructure (mostly done) ✅

These are pure infrastructure with no upstream blockers. Tier 1 unlocks
three downstream tracks (per-student GWS, per-student provider auth,
per-agent MCP role checks). All but the smoke matrix done.

1. ✅ **gws-mcp 13.1 — delete dead OneCLI skills.** Done in commit
   `8f5f040` (skills removed) + `52a8290` (plan checkboxes ticked).
2. ✅ **credential-proxy per-call attribution.** Shipped on `main` in
   merge `4161e55`. X-NanoClaw-Agent-Group header (Candidate A);
   container-side proxy-fetch wrapper; proxy reads + strips +
   per-student GWS resolver. Phases X.1–X.3 + X.6 of
   `credential-proxy-per-call-attribution.md`. X.4 (per-provider OAuth
   resolvers) deferred to Phase 4 work; X.5 (per-request observability
   log) deferred as a small follow-up.
3. 🛠 **ai-coding-cli Phase G — smoke matrix.** ~2 hr.
   Per `ai-coding-cli-pick.md` Phase G + the test list in
   `upstream-pr-prep.md` §1. Pure verification work; clears the
   upstream-PR signal for that subsystem.

### Tier 2 — payoffs of Tier 1 ✅

4. ✅ **classroom Phase 3 slice B — per-student GWS read in proxy.**
   Folded into the Tier 1 #2 keystone merge (`4161e55`). The proxy
   now consults `data/student-google-auth/<id>/credentials.json`
   first, falls back to the instructor's token. `gws-token.ts` is
   the shared resolver used by both proxy + GWS MCP.
5. ✅ **gws-mcp Phase 13.2 — host-side MCP server.** Shipped in
   `4161e55`. `src/gws-mcp-tools.ts` + `src/gws-mcp-server.ts`
   exposing `drive_doc_read_as_markdown` +
   `drive_doc_write_from_markdown` via `@googleapis/drive` 20.1.0
   + `@googleapis/docs` 9.2.1.
6. ✅ **gws-mcp Phase 13.3 — per-agent relay with role check.**
   Shipped in `4161e55`. `src/gws-mcp-relay.ts` listens on
   loopback `:3007`, reads X-NanoClaw-Agent-Group, validates the
   agent group exists, dispatches into the in-process server.
7. ✅ **gws-mcp Phase 13.4 — container → relay + install skill.**
   Shipped in commit `cecfb36`. `container/agent-runner/src/mcp-tools/gws.ts`
   rewritten to POST `${GWS_MCP_RELAY_URL}/tools/<name>` with explicit
   `X-NanoClaw-Agent-Group` header (no separate stub file — global
   tool registration kept, single-file refactor). `GWS_BASE_URL`
   removed from container env (was only used by `gws.ts`).
   `.claude/skills/add-gws-tool/SKILL.md` packages the install.
   First `/ultrareview` candidate once the service is healthy
   (memory: 4 prior attempts failed on backend issues, not branch).

### Tier 2b — GWS follow-ons (active worklist)

8. 🛠 **gws-mcp Phase 13.5 sub-phases.** Sub-plan written in
   [gws-mcp-v2.md](gws-mcp-v2.md). Each is gated on a real use
   case showing up; sheets (13.5a) is the suggested first lander
   when a classroom gradebook need appears.
9. 🛠 **`wasFallback` infra prerequisite.** ~1 hr. Extend
   `getGoogleAccessTokenForAgentGroup` to return `{ token, principal }`
   where `principal` is `'self' | 'instructor-fallback'`. Lets every
   V2 sub-phase enforce its mode-2 refusal stance. Independent of
   Phase 14 — landable today.
10. 🛠 **Phase 14 — per-student GWS OAuth.** Designed in
    [gws-mcp.md](gws-mcp.md) §Phase 14. Magic-link flow on the
    student-auth-server (port 3003), per-student credentials at
    `data/student-google-auth/<id>/`, `/gauth` Telegram command.
    **Partly blocked on GCP redirect URI** registration — see
    `project_gcp_oauth_pending` memory; deferred until Mac Studio
    LAN IP is assigned. Code can land now (gated behind a feature
    flag) and verification waits for the URI.
11. 🛠 **`scripts/gws-authorize.ts`** — referenced in plans as
    "foundation already in place" but doesn't actually exist on
    disk. ~30 min. One-off CLI wrapping `src/gws-auth.ts` helpers
    so the instructor can mint a fresh refresh token via localhost
    callback. Useful today (recovers from expired-token states);
    becomes the manual-test backstop for Phase 14.

### Tier 3 — independent small wins (interleave anywhere after Tier 1)

These don't block anything and don't depend on anything new. Slot
them in between the heavier Tier 2 items if you want a smaller-win
break.

12. **classroom Phase 6 — local-LLM runbook + .env.** ~2–3 hr.
    Mostly docs + a small audit of `credential-proxy.ts` for
    `OPENAI_BASE_URL` correctness with arbitrary upstream hosts.
    Exact phase content in `classroom-web-multiuser.md` §Phase 6.
13. **classroom Phase 5 — agent export tooling.** ~4–5 hr.
    `nanoclaw / claude-code / codex / json` formats; `GET
    /api/draft/<folder>/export?format=…`. Spec in
    `classroom-web-multiuser.md` §Phase 5.

### Tier 4 — UI surface for everything above

14. **classroom Phase 4 — home page expansion.** ~9–12 hr.
    Provider settings panel (depends on Tier 1 #2 + per-student
    Anthropic/OpenAI auth — see Decision 10 in the multi-user plan),
    dashboard, picker filter, Telegram link. Spec in
    `classroom-web-multiuser.md` §Phase 4.

### Tier 5 — lab content (the bulk of in-class work)

15. **classroom Phase 7 — expert system builder + RAG strategies.** ~12–30 hr.
    Pipeline framework + named strategies + UI. Scope decisions still
    open (lab sequence, capstone-stage support). Spec in
    `classroom-web-multiuser.md` §Phase 7. Cost-economical only after
    Tier 3 #12 lands (local LLM).
16. **classroom Phase 8 — evaluation framework.** ~8–10 hr.
    Side-by-side comparison view + LLM-as-judge mode. Depends on
    Phase 7 (no strategies = nothing to evaluate). Spec in
    `classroom-web-multiuser.md` §Phase 8.

### Tier 6 — semester capstone

17. **classroom Phase 9 — walk-away cloud deploy.** ~6–8 hr.
    Bundle + bootstrap script. Depends on Tier 3 #13 (export) for the
    bundle format. Spec in `classroom-web-multiuser.md` §Phase 9.

## Cross-cutting

- **Live in-browser smoke for Phases 1–3.** Gated on the Mac Studio
  having a LAN IP + the GCP redirect URI being registered for that
  IP. See `project_gcp_oauth_pending` memory.
- **Upstream `qwibitai/nanoclaw` PR candidates.** Tracked per
  subsystem in `upstream-pr-prep.md`. Phase 1 (multi-user playground
  fix) is the cleanest standalone candidate; held until live
  verification.
- **Branch hygiene.** Merges to `main` and to `origin/classroom` use
  `--no-ff` so each phase stays revertable as a single merge commit.
  Feature branches deleted (local + remote) once merged.
- **`/ultrareview` deferred for the credential-proxy + GWS MCP
  bundle + Phase 13.4.** Service was 100% broken across 4 attempts
  (503 / two zlib failures / 502) — backend issue, not branch
  content. Bundle merged to `main` based on test coverage (510 host
  + 124 container) + the deliberate self-audit. Phase 13.4 landed on
  top with its own test pass (510 host + 124 container). Next
  `/ultrareview` candidate when the service is back is the whole
  GWS MCP arc (13.2 → 13.3 → 13.4) reviewed against `main`, or the
  next architecturally-novel chunk (`wasFallback` infra, Phase 14
  scaffold, or Phase 4 home page expansion).
- **Memory note.** `feedback_ultrareview_before_merge.md` says to
  run `/ultrareview` *before* merging feature work — going forward,
  feature-branch new work and ultrareview on the branch tip before
  merging to main, not after.

## How to use this file

- When starting a session, read this file's "Order of work" to pick
  the next item.
- When an item ships, record its merge commit in the "What's shipped"
  table at the top.
- When a sub-plan adds new phases, list them under the relevant tier
  here so the order is maintained.
- When a tier's work is fully done, mark it with ✅ in the heading.
