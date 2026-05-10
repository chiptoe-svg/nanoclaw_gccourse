# NanoClaw gccourse — master plan

Single entry point for what to do next on this fork. The detailed
designs live in the sub-plans referenced inline; this file is the
sequencing layer.

## What's shipped

| Subsystem | Where it landed |
|---|---|
| Setup-CLI picker (Phases A–F) | `main`, commits per `plans/setup-cli-pick.md` |
| Agent Playground v2 | installed via `/add-agent-playground`, declared SHIPPED in `plans/agent-playground-v2.md` |
| Class feature foundation (`/add-classroom*` skills) | `origin/classroom` branch |
| Multi-user playground session store (Phase 1) | `main` (merge `7e5398d`) |
| Google OAuth + roster + minimal home (Phase 2) | `main` (merge `f7d1fa8`) |
| Per-student GWS refresh-token persistence (Phase 3 slice A) | `main` (same merge) |
| `--roster <csv>` flag in `class-skeleton.ts` (slice B partial) | `origin/classroom` (merge `63d87c7`) |

Latest tracker: `plans/upstream-pr-prep.md` for the per-item PR-readiness state.

## Sub-plans (active)

| Plan | Subject | Status |
|---|---|---|
| [classroom-web-multiuser.md](classroom-web-multiuser.md) | Phases 4–9 of the class web rebuild | Phases 1–3 (A) shipped; 4–9 pending |
| [credential-proxy-per-call-attribution.md](credential-proxy-per-call-attribution.md) | Per-call agent-group attribution in the credential proxy | Plan only; **keystone for tier 2** |
| [gws-mcp.md](gws-mcp.md) | Host-side Google Workspace MCP (Doc/Drive/Sheet tools) | 13.0 done; 13.1–13.4 pending |
| [setup-cli-pick.md](setup-cli-pick.md) | Setup-CLI picker | A–F shipped; only Phase G (smoke matrix) left |

## Sub-plans (archived as historical)

`agent-playground-v2.md` (self-marked SHIPPED). Kept as design-record;
not on the active worklist.

## Order of work

The dependency graph picks the order — items land when their blockers
clear. Tier numbers are coarse buckets; within a tier, items can run
in any sequence (or in parallel via worktrees).

### Tier 1 — keystone infrastructure (do first)

These are pure infrastructure with no upstream blockers. Tier 1 is
short, but it unlocks three downstream tracks (per-student GWS,
per-student provider auth, per-agent MCP role checks) that all wait
on the same architectural decision.

1. **gws-mcp 13.1 — delete dead OneCLI skills.** ~30 min.
   `.claude/skills/add-gmail-tool/` and `.claude/skills/add-gcal-tool/`
   require a OneCLI gateway this install doesn't have. Phase 13's
   `/add-gws-tool` supersedes them. Trivial cleanup; no blockers.
2. **credential-proxy per-call attribution.** ~6–10 hr.
   Full plan in `credential-proxy-per-call-attribution.md`. Recommended
   mechanism: header injection (Candidate A). Implementation phases
   X.1–X.6 in that plan.
3. **setup-cli Phase G — smoke matrix.** ~2 hr.
   Per `setup-cli-pick.md` Phase G + the test list in
   `upstream-pr-prep.md` §1. Pure verification work; clears the
   upstream-PR signal for that subsystem.

### Tier 2 — payoffs of Tier 1 (depends on attribution landing)

Each item here was waiting on Tier 1 #2.

4. **classroom Phase 3 slice B — per-student GWS read in proxy.** ~2 hr.
   Extends the per-credential resolver chain in the proxy to consult
   `data/student-google-auth/<id>/credentials.json` first, falling
   back to the instructor's token. Was deferred at Phase 3 ship time
   because the attribution primitive didn't exist.
5. **gws-mcp Phase 13.2 — host-side MCP server.** ~6–8 hr.
   `src/gws-mcp-server.ts` + `src/gws-mcp-tools.ts` exposing
   `drive_doc_read_as_markdown` + `drive_doc_write_from_markdown`.
   Reuses `src/gws-auth.ts` for the OAuth refresh.
6. **gws-mcp Phase 13.3 — per-agent relay with role check.** ~3–4 hr.
   `src/gws-mcp-relay.ts` does the JSON-RPC pass-through, calling
   `canAccessAgentGroup` to gate access. Now genuinely possible
   because Tier 1 #2 added the per-call agent-group identity.
7. **gws-mcp Phase 13.4 — container stub + skill.** ~3–4 hr.
   `container/agent-runner/src/mcp-tools/gws-stub.ts` forwards to the
   host relay; `.claude/skills/add-gws-tool/` packages the install.

### Tier 3 — independent small wins (interleave anywhere after Tier 1)

These don't block anything and don't depend on anything new. Slot
them in between the heavier Tier 2 items if you want a smaller-win
break.

8. **classroom Phase 6 — local-LLM runbook + .env.** ~2–3 hr.
   Mostly docs + a small audit of `credential-proxy.ts` for
   `OPENAI_BASE_URL` correctness with arbitrary upstream hosts.
   Exact phase content in `classroom-web-multiuser.md` §Phase 6.
9. **classroom Phase 5 — agent export tooling.** ~4–5 hr.
   `nanoclaw / claude-code / codex / json` formats; `GET
   /api/draft/<folder>/export?format=…`. Spec in
   `classroom-web-multiuser.md` §Phase 5.

### Tier 4 — UI surface for everything above

10. **classroom Phase 4 — home page expansion.** ~9–12 hr.
    Provider settings panel (depends on Tier 1 #2 + per-student
    Anthropic/OpenAI auth — see Decision 10 in the multi-user plan),
    dashboard, picker filter, Telegram link. Spec in
    `classroom-web-multiuser.md` §Phase 4.

### Tier 5 — lab content (the bulk of in-class work)

11. **classroom Phase 7 — expert system builder + RAG strategies.** ~12–30 hr.
    Pipeline framework + named strategies + UI. Scope decisions still
    open (lab sequence, capstone-stage support). Spec in
    `classroom-web-multiuser.md` §Phase 7. Cost-economical only after
    Tier 3 #8 lands (local LLM).
12. **classroom Phase 8 — evaluation framework.** ~8–10 hr.
    Side-by-side comparison view + LLM-as-judge mode. Depends on
    Phase 7 (no strategies = nothing to evaluate). Spec in
    `classroom-web-multiuser.md` §Phase 8.

### Tier 6 — semester capstone

13. **classroom Phase 9 — walk-away cloud deploy.** ~6–8 hr.
    Bundle + bootstrap script. Depends on Tier 3 #9 (export) for the
    bundle format. Spec in `classroom-web-multiuser.md` §Phase 9.

## Cross-cutting

- **Live in-browser smoke for Phases 1–3 A.** Gated on the Mac Studio
  having a LAN IP + the GCP redirect URI being registered for that
  IP. See `project_gcp_oauth_pending` memory.
- **Upstream `qwibitai/nanoclaw` PR candidates.** Tracked per
  subsystem in `upstream-pr-prep.md`. Phase 1 (multi-user playground
  fix) is the cleanest standalone candidate; held until live
  verification.
- **Branch hygiene.** Merges to `main` and to `origin/classroom` use
  `--no-ff` so each phase stays revertable as a single merge commit.
  Feature branches deleted (local + remote) once merged.

## How to use this file

- When starting a session, read this file's "Order of work" to pick
  the next item.
- When an item ships, record its merge commit in the "What's shipped"
  table at the top.
- When a sub-plan adds new phases, list them under the relevant tier
  here so the order is maintained.
- When a tier's work is fully done, mark it with ✅ in the heading.
