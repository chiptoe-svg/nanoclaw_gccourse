# Agent Playground v3 — Design

**Status:** Brainstorm complete. Implementation plan TBD.
**Predecessor:** [`plans/agent-playground-v2.md`](../../../plans/agent-playground-v2.md) (SHIPPED, code in `src/channels/playground.ts` and `src/channels/playground/`).
**Related:** [`plans/master.md`](../../../plans/master.md) (Phase 2 work — playground rebuild precedes per-student GWS OAuth).

## Why a v3

The v2 playground works but accreted features (light theme, brand pass, mode pills, file editor, diff view, trace panel, role-aware lockdown for class) without a coherent overall design. The result is clunky on the student side — the most important audience now that Phase 1 has shipped.

The v3 redesign reframes the playground from "operator's authoring workbench" into "**student learning surface** (with the instructor using the same surface for demos)." The pedagogical goal is for students to *experience* developing and fine-tuning agent behavior — including the **economic and speed trade-offs** between models and skill choices.

## Audience and workflow

- **Primary user:** student in a NanoClaw classroom deployment.
- **Secondary user:** instructor demonstrating live (uses the same surface, no separate "demo mode").
- **Workflow shape:** mixed — starts free-form ("play with the knobs and see what happens"), evolves into structured assignments by mid-semester. The surface must be inviting on day 1 *and* support deliberate task work.

## Core concept changes

| Concept | v2 | v3 |
|---|---|---|
| Unit of work | Draft = experimental agent that gets applied to a target group | Each student has **one current agent** (the agent group assigned to them by `/add-classroom`), edited via a transient **draft state**. No "target." |
| Snapshots | Not a concept | Saved versions live in **My library**; same mechanism as picking a Default or Class library entry to start from |
| Persona surface | Single textarea on `CLAUDE.local.md` | Three-panel (Library / Preview / Active) with sub-tabs to inspect read-only base layers |
| Skills surface | Two-column enable/disable toggle | Three-panel (Library / Preview-with-file-tree / Active) with cost annotations |
| Model surface | Hardcoded claude/codex toggle in topbar | Dedicated **Models** tab — whitelist of allowed models with cost/speed/modalities/notes |
| Cost/speed | Invisible | Per-message annotation under every agent reply |
| Apply / Save | Single "Apply" button in topbar | **Draft banner** at top of every tab with three actions: Discard / Save to my library / Apply to my agent |

## Surface

### Header (always visible)

- Brand mark.
- "Current agent: **\<name\>**" (the locked-in version that survives container restarts).
- Authenticated user.
- Tab bar: **Chat / Persona / Skills / Models**.

### Draft banner (appears when there are unsaved edits — top of every tab)

- "⚠ Draft — \<agent\> has unsaved changes."
- Three buttons, distinct color treatment:
  - **↩ Discard** (red-tinged) — reset draft to current agent state.
  - **💾 Save to my library…** (green) — name + freeze the current draft as a library entry. Doesn't affect "current agent."
  - **✓ Apply to my agent** (blue, primary) — make draft permanent (writes persona / skills / model fields onto the current agent group). Survives container restarts and library reloads. Does **not** kill the running container — only provider changes do that, and the provider switch has its own modal in the Chat tab.

The draft banner is the **single source of truth** for committing or discarding changes. Apply / Save / Discard exist nowhere else.

### Tab 1 — Chat

- **Toolbar** (top): "Chat with: \<agent\>" · provider dropdown (claude / codex / opencode / ollama) · model dropdown (filtered by selected provider).
- **Two-column body:**
  - Left (~60%): chat log + input. Each agent reply gets a small annotation line: `provider/model · N tok · $0.00X · 0.Ys`.
  - Right (~40%): trace panel — tool calls, tool results, system events. Already wired for the Claude provider via `ProviderEvent` types `tool_use` / `tool_result` (see `container/agent-runner/src/providers/types.ts`); other providers' trace surfacing is a known follow-up tracked in `plans/master.md`.
- **Provider switch UX:** confirmation modal — *"Switching from \<X\> to \<Y\> will reset this chat (kills the running container; persona, skills, library entries are not affected). Cancel / Switch & reset chat."* Matches existing behavior in `src/channels/playground/api-routes.ts` `/api/drafts/:folder/provider` (PUT kills container).
- **Model switch UX:** no modal. Inline pill on the dropdown: "↻ next message". Italic note in chat log: "— model changed to \<X\>; next reply will use it —".
- Chat **always talks to the current draft state**, not a saved version. Editing the persona in another tab and switching back to Chat picks up the change automatically; no "save draft" intermediate step.

### Tab 2 — Persona

Three panels: Library / Preview / Active. Library is a fixed-width sidebar (~150px); Preview and Active share the rest of the width.

**Library (left panel):** scrollable list with a filter input. Three sections, all read-only as a list (deletion of My library entries is out of scope for v3 — handled later via a separate "manage my library" surface or CLI):

- **Default agents** — bundled with NanoClaw (renamed from any "nanoclaw default" labels). Same set every install.
- **Class library** — instructor-curated. Already partially populated on this install.
- **My library** — student-saved snapshots. Created via "Save to my library…" in the draft banner.

Click an entry → loads it into the Preview panel.

**Preview (middle panel):** read-only display of the selected library entry's persona text. Header shows source section + persona's preferred provider/model + skills used. Body is a `<pre>` tag with selectable text. Hint at top-right: "read-only · ⌘A then ⌘C to copy". No magic buttons — copying is native browser behavior.

**Active (right panel):** the agent's actual editable state. Sub-tab strip at top:

- **✏️ My persona** (active) — editable textarea backed by `groups/<folder>/CLAUDE.local.md`. Paste / edit / delete are native.
- **🔒 Group base** (read-only) — `groups/<folder>/CLAUDE.md` after `@import` resolution. Shows the auto-composed module fragments (telegram messaging, scheduling, wiki, etc.).
- **🔒 Container base** (read-only) — `container/CLAUDE.md`. Common to all NanoClaw agents on this install.
- **🔒 Global** (dimmed when absent) — `groups/global/CLAUDE.md` if present (typically absent in v2).

Footer of the Active panel:
- `prefers provider: <dropdown>` — same options as Chat tab.
- `model: <dropdown>` — filtered by selected provider.

Edits to any of these (textarea content, prefers provider, model) trigger draft state and surface the draft banner.

### Tab 3 — Skills

Same three-panel pattern as Persona.

**Library (left, fixed-width sidebar):** sections for **Anthropic library** (the cloned `anthropic/skills` cache — existing in v2), **Class skills** (instructor-authored, lives on `classroom` branch), and **My skills** (student-authored). Below the list: **+ Author my own skill…** button (sub-flow for creating a new skill — design TBD as part of implementation).

**Preview (middle):** file tree on the left + file viewer on the right. Skills are sometimes a single SKILL.md, sometimes a directory with multiple files (scripts, references, examples). The tree handles both. Default-selected file: SKILL.md.

**Active (right):** list of currently-enabled skills for the agent. Each entry shows skill name + estimated cost impact (`+~N tok/turn`) + a remove button. Footer: aggregate "Estimated cost impact" and "Latency impact" totals.

Cost/latency annotations on skills are estimates, sourced from per-skill metadata (added to SKILL.md frontmatter as `cost_tokens` / `latency_ms` — populated on a best-effort basis; missing values render as "?"). Population of the metadata across the existing skill catalog is part of implementation.

### Tab 4 — Models

Card grid. Each card represents one model the install can route to. Cards are checkable — checked = "this model is allowed for the agent to use" (whitelist).

**Common card fields (all models):**
- Checkbox + display name.
- Speed/cost/origin chips (e.g., "⚡ fast · $ cheap · ☁ Anthropic" or "🏠 local · 🆓 free · 🐢🐢 hardware-bound").
- `$X / 1k tokens · Ys avg latency`.
- `params: <count> · modalities: <text/image/audio>`.
- Notes line (free-form, instructor-authored on a class deployment).

**Local-model cards** (Ollama, mlx-omni-server, LM Studio, anything OpenAI-compatible at a custom base URL) get an extra inset:
- `host: <url>` (the custom OpenAI base URL).
- `context: <size> · quantization: <Q4_K_M / FP16 / etc.>`.
- `status: ● online | ○ offline` (live polled from the host).

The whitelist controls which models appear in the Chat tab and Persona tab dropdowns. Picking a persona that prefers a model outside the whitelist surfaces a warning when loading.

## Architecture

### Host-side: persona-layers helper (new)

New module: **`src/persona-layers.ts`**.

Single exported function:

```typescript
function getEffectivePersonaLayers(folder: string): {
  myPersona:     string;            // groups/<folder>/CLAUDE.local.md
  groupBase:     string;            // groups/<folder>/CLAUDE.md with @imports resolved
  containerBase: string;            // container/CLAUDE.md
  global?:       string;            // groups/global/CLAUDE.md if present
};
```

Refactor `resolveClaudeImports` from `container/agent-runner/src/providers/codex.ts:54` into a shared utility (e.g., `src/lib/claude-imports.ts` or a small package under `container/agent-runner` re-exported to both runtimes — design call during implementation since the function is pure and could live in either tree).

The playground API consumes this single function regardless of whether the agent is configured to use Claude or Codex; provider-specific quirks stay in agent-runner.

### Host-side: model whitelist storage (new)

Whitelist is a per-agent-group setting. Add to `agent_groups` schema or `container.json` (decision during implementation — leans `container.json` since model selection already lives there). API:

- `GET /api/drafts/:folder/models` — returns whitelist + the model catalog (cards above).
- `PUT /api/drafts/:folder/models` — replaces the whitelist.

Model catalog comes from a static config (`src/model-catalog.ts` or similar), populated with cost/speed/params/modalities for each known model. Local-model entries are append-only at install time (instructor adds entries pointing at their Ollama / mlx-omni / LM Studio host).

### Host-side: library tier (new)

Three-tier listing in the Persona tab:

- **Default agents** — directory shipped with NanoClaw under `library/default-agents/`. Must be **renamed** from any current "nanoclaw" labelling per user request. Concrete on-disk layout (single file vs. directory-per-entry) is an open implementation question — see below.
- **Class library** — directory installed by `/add-classroom` (lives on `classroom` branch) under `library/class/`. Same on-disk layout as Default.
- **My library** — per-student under `data/student-libraries/<student_id>/`. Same on-disk layout.

Reads/writes via API: `GET /api/library` (returns all three tiers), `POST /api/library/my/:name` (save current draft as named entry), `GET /api/library/:tier/:name` (load entry — returns persona text + preferred provider/model + skills list).

### Host-side: per-message cost/speed tracking

Provider events (`ProviderEvent` in `container/agent-runner/src/providers/types.ts`) need to carry token counts and latency. Today's `result` event has `text` only; extend to include token counts (`{ input, output }`) and latency (timestamp on `init` + `result`). The poll-loop writes this to `outbound.db` as part of the message row (or a sibling row) so playground SSE can surface it.

Per-message annotation rendering on the client is purely additive — the existing chat log gets a small grey line under each agent reply.

### Client-side: full UI rewrite

The 5-mode v2 UI (Chat / Persona / Skills / Files / Diff) does not survive intact. Diff mode, Files mode, and the standalone Persona mode collapse into the new 4-tab structure (Files mode's escape-hatch role is dropped — students don't need raw container.json access; what they actually want is exposed via Skills + Models). Trace panel survives and moves into Chat tab as the right column.

Client architecture stays the same shape (vanilla TS/JS over SSE + REST, no framework). File reorg is part of the implementation plan.

## Out of scope for v3

- **Per-skill cost backfill across the entire `anthropic/skills` catalog** — populate metadata on a best-effort basis; missing values render as "?".
- **Trace surfacing for non-Claude providers** — known follow-up in `plans/master.md`. v3 ships with trace working on Claude only.
- **Managing My library entries (rename, delete, reorder)** — list-only in v3. A separate surface or CLI command later.
- **Skill authoring sub-flow** — placeholder button in v3 (`+ Author my own skill…`); the actual flow is its own design pass.
- **Live local-model status polling** — display is live-updating but the "status: online/offline" mechanism (timer? on-demand?) is an implementation detail to nail down then.
- **Multi-model concurrent comparison** — no "run this prompt against snapshot A and B side-by-side." Save snapshots, switch between them, compare manually. (Could be a future tab.)

## Open implementation questions

These can be deferred to the writing-plans phase but are flagged here so the plan author doesn't have to re-derive them:

1. **Where does the whitelist live** — `agent_groups` table column or `container.json`? Leaning `container.json` since model already lives there and per-spawn pickup is automatic.
2. **Where does the static model catalog live** — host code (`src/model-catalog.ts`) or instructor-editable file (`config/model-catalog.json`)? Leaning host code for the cloud entries (versioned with NanoClaw); instructor-editable JSON for the local entries.
3. **Refactor target for `resolveClaudeImports`** — move to host (and have agent-runner depend on it via build-time copy / shared package), or duplicate across both runtimes? The function is ~15 lines of pure code; duplication may be cheaper than coupling.
4. **Library entry format** — single JSON file per entry, or a directory with `persona.md` + `manifest.json`? Directory gives room for future expansion (per-entry skills bundle, per-entry model whitelist override, screenshots, …) but adds filesystem complexity.

## Success criteria

- A student can open the playground, click into Persona, browse Default agents, click `socratic_tutor`, copy the text into their My persona, switch to Chat, send a message, and see per-message cost/speed annotations — without seeing a single error or needing to ask the instructor what a button means.
- A student can switch the model in Chat (no warning) and see the next reply use the new model with new cost/speed numbers.
- A student can switch the provider in Chat, see the warning modal, accept it, and have a fresh chat under the new provider.
- A student can click "Save to my library…", name the snapshot, see it appear in their My library section, navigate away, come back, click the snapshot, and see it preview correctly.
- An instructor can add a Local model card (pointing at their classroom Ollama box) and see it appear in the Models tab with online status, params, modalities, and instructor notes.
- The Persona tab right-panel sub-tabs render the same content for an agent_provider=`claude` group as for an agent_provider=`codex` group (provider-uniform via `getEffectivePersonaLayers`).
