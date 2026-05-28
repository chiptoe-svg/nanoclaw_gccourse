# Instructor class-pool credentials + provider grouping (Phase C)

**Goal.** Land the hybrid provider model end-to-end:

- Class-pool credentials = the **instructor's own per-user creds** (same
  store students use), not host `.env`.
- LLM Providers card has two layouts: **student view** (existing,
  unchanged) and **instructor view** (new — per-group rows, sub-rows per
  auth method, Apply-to-class affordance).
- Class Controls "Provided" greys out when the instructor hasn't
  connected the matching credential yet.
- Models tab folds duplicate-catalog spec sections (OpenAI subscription
  + OpenAI API; Anthropic Claude Code OAuth + Anthropic API) into a
  single user-facing section per group from
  `provider-groups.js`.
- Chat-tab routing for a grouped model picks the right underlying spec
  at request time based on which credentials exist (instructor active
  method when class-pool; student active method when BYO).

Companion to [`plans/class-controls-provider-grouping.md`](class-controls-provider-grouping.md) — that one shipped
the Class Controls form rewrite (Phase 1). This plan is everything else.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Class Controls card (Visible / Provided / BYO per group)           │
│   "Provided" is policy; backing creds live in owner's per-user     │
│   store via studentCredsHook → classPoolCreds().                   │
└─────────────┬──────────────────────────────────────────────────────┘
              │ owns
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ LLM Providers card (instructor view) — class-pool credential store │
│   Per group: sub-row per auth method (OAuth, API key, etc.),       │
│   active-method radio when both connected, Apply-to-class button   │
│   that flips the Provided toggle on the Class Controls card.       │
└─────────────┬──────────────────────────────────────────────────────┘
              │ reads at request time
              ▼
┌────────────────────────────────────────────────────────────────────┐
│ credential-proxy.studentCredsHook                                  │
│   resolveStudentCreds(agentGroupId, providerId)                    │
│     1. per-student creds (today)                                   │
│     2. policy.provideDefault === true                              │
│        → classPoolCreds(classId, providerId)  [NEW]                │
│          = owner's per-user creds via loadStudentProviderCreds     │
│     3. policy.allowByo === true → connect_required sentinel        │
└────────────────────────────────────────────────────────────────────┘
```

**Single source of truth (already exists):** `provider-groups.js` lists
the 4 user-facing groups and their member spec ids. Everything new in
this plan reads from it.

---

## Phase C-1: class-pool resolver wiring + `.env` migration

The resolver seam already exists (`classPoolCreds` in
`classroom-provider-resolver.ts:92`); today it defaults to `() => null`
and falls through to `.env`. Implement it as "load owner's per-user
creds" and migrate any `.env`-resident class-pool keys into the owner
store at startup.

### Files

| Path | Change |
|---|---|
| `src/db/user-roles.ts` (or wherever owner lookup lives — verify) | Export `getOwnerUserId(): string \| null` if not already present. |
| `src/classroom-provider-resolver.ts` | Replace the `() => null` default for `classPoolCreds` with an implementation that looks up the owner, loads their per-user creds for `providerId`, branches on `active` the same way the per-student path does, and refreshes OAuth if expiry is near. |
| `src/env-to-owner-migration.ts` *(new)* | One-time startup migration: read `.env` keys (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `OPENAI_PLATFORM_API_KEY`, `CAMPUS_LLM_API_KEY`, `OMLX_*`), upsert into owner's per-user creds for the matching spec id, mark migration done in a session-state key so it doesn't re-run. |
| `src/index.ts` | Call the migration once after migrations + roster init, before the credential-proxy starts. |
| `src/classroom-provider-resolver.test.ts` | New unit tests: provideDefault=true + owner has api-key cred → returns apiKey; + owner has oauth → returns oauth; + owner has nothing → returns null (fall through to .env, which now is empty); + no owner row → returns null. |

### Tasks

- [ ] **C-1.1** Verify whether `getOwnerUserId()` already exists; if not, add it as a 5-line helper hitting `user_roles` (`SELECT user_id FROM user_roles WHERE role='owner' AND agent_group_id IS NULL LIMIT 1`).
- [ ] **C-1.2** TDD: write failing tests for the new `classPoolCreds` behavior in `classroom-provider-resolver.test.ts`. Cover the four cases listed above.
- [ ] **C-1.3** Implement the resolver default. Inline the same active-method branching + OAuth refresh that the per-student path uses.
- [ ] **C-1.4** Tests pass.
- [ ] **C-1.5** TDD: write failing test for the env-to-owner migration. Cover: migration writes to owner creds, marks done flag, second run is a no-op.
- [ ] **C-1.6** Implement the migration. Read each `.env` key; if set and owner-side cred missing, upsert; record `migration_done='env_to_owner_v1'` in central DB session-state.
- [ ] **C-1.7** Wire into `src/index.ts` startup sequence. Add log line on first-run completion.
- [ ] **C-1.8** Verify locally on the running install:
  - Inspect `student_provider_auth` rows for the owner user before restart
  - Restart host, expect new rows for whichever providers had `.env` keys set
  - Re-restart, expect no-op (migration_done flag prevents re-run)
- [ ] **C-1.9** Commit.

### Migration behavior — explicit

- **`.env` keys are NOT deleted.** They remain as a recovery hatch.
- **The resolver no longer reads `.env`** for these providers — only the
  owner's per-user creds via `classPoolCreds`.
- A `.env`-resident key changed after migration **does NOT propagate**.
  Instructor edits in the LLM Providers card are the source of truth.

### Verification

- `pnpm test` green; new resolver tests pass.
- Live: one round-trip on a student session confirms that toggling
  Provided uses the owner's connected credential (e.g., disconnect
  owner's OpenAI API key in the card → student calls fail with 502
  "instructor hasn't connected …"; reconnect → calls succeed).

---

## Phase C-2: LLM Providers card — instructor view

### Files

| Path | Change |
|---|---|
| `src/channels/playground/public/tabs/home.js` | Split `renderProvidersCard` on `user.role`. Owner + TA → new `renderInstructorProvidersCard`. Student → existing path. |
| `src/channels/playground/public/tabs/home.js` | New `renderInstructorProvidersCard`: groups specs via `PROVIDER_GROUPS`, renders one card per group with sub-rows per auth method (Connected / Not connected), active-method radio inline when ≥2 sub-rows connected, Apply-to-class button on each group row. |
| `src/channels/playground/api/me-providers.ts` (verify path) | If a separate endpoint per spec already exists for paste/disconnect (probably does), reuse. Owner pastes flow through the same endpoints; their `userId` already routes into `loadStudentProviderCreds` keyed by their id. |
| `src/channels/playground/api/class-controls.ts` | Add a small `POST /api/class-controls/apply-from-creds` (or extend the existing PUT shape) — accepts `{ groupId }`, sets every member spec's `provideDefault=true`, returns the updated state. Simpler than client-side patching the whole controls object. |
| `src/channels/playground/public/tabs/home.js` | Apply-to-class button wires to the new endpoint, then refreshes both the LLM Providers card AND the Class Controls card. |

### Tasks

- [ ] **C-2.1** Sketch `renderInstructorProvidersCard` rendering pattern in the plan PR description first — the layout is the most opinionated piece.
- [ ] **C-2.2** Branch `renderProvidersCard` on `user.role` (owner/TA → new path, else current).
- [ ] **C-2.3** Implement the group-row + sub-row template. Sub-rows show: auth method name, status (Connected with email / Set / Not connected), action button (Connect / Paste / Disconnect).
- [ ] **C-2.4** Inline active-method radio appears when ≥2 sub-rows are connected. Posts to `/api/me/providers/<specId>/active` (existing endpoint).
- [ ] **C-2.5** Apply-to-class button next to the group header. Calls the new class-controls endpoint, refreshes both cards.
- [ ] **C-2.6** Live verify in browser: open Home as owner, connect Anthropic Claude Code OAuth, click "Apply to class," confirm Anthropic / Provided checked on Class Controls, save → student session sees Anthropic available.
- [ ] **C-2.7** Commit.

### Card layout sketch (to be reviewed pre-implementation)

```
LLM Providers
─────────────────────────────────
Anthropic                              [Apply to class]
  ● Claude Code OAuth — chiptoe@mac.com  ○ active   [Disconnect]
  ○ Anthropic API key — Not set                     [Paste]

OpenAI                                 [Apply to class]
  ○ ChatGPT subscription — Not connected            [Connect]
  ● Platform API key — Set                ● active   [Remove]

Local (OMLX)                           [Apply to class]
  ○ Base URL — http://localhost:8000                [Edit]
  ○ API key  — Set                                  [Remove]

Clemson                                [Apply to class]
  ○ API key — Set                                   [Remove]
```

(`●` / `○` = connected / not. The radio appears only when ≥2 sub-rows are
connected; before that, the only connected method is implicitly active.)

---

## Phase C-3: Class Controls — grey out "Provided" without creds

### Files

| Path | Change |
|---|---|
| `src/channels/playground/api/class-controls.ts` | Extend the GET response to include `providedReady: { [groupId]: boolean }` — `true` when at least one member spec has an active credential in the owner's per-user store. |
| `src/channels/playground/public/tabs/home.js` | `renderClassControlsForm` reads `providedReady[g.id]`. When `false`: disable the Provided checkbox, add `title="Connect a credential in the LLM Providers card first."` tooltip. Save handler ignores disabled toggles. |

### Tasks

- [ ] **C-3.1** Add `providedReady` to the GET response. Cheap query: `loadStudentProviderCreds(ownerId, specId)` for each member, OR them.
- [ ] **C-3.2** Render disabled state + tooltip in the form.
- [ ] **C-3.3** Live verify: with no owner creds set, OpenAI's Provided is greyed; connect OpenAI Platform key, refresh page, Provided is now toggleable.
- [ ] **C-3.4** Commit.

---

## Phase C-4: Models tab grouping

### Files

| Path | Change |
|---|---|
| `src/channels/playground/public/tabs/models.js` | Fold catalog entries by `PROVIDER_GROUPS`. One section per user-facing group; section header from group `displayName`. Within a section, deduplicate model entries that appear under multiple member specs (codex's `gpt-5.5` + openai-platform's `gpt-5.5` — same id, same costs). The dedupe key is `id`; preserve one canonical entry. Tag each entry with the source `modelProvider` for routing (see C-5). |
| `src/channels/playground/api/models.ts` | Discovered models also fold to groups for display. Underlying `modelProvider` stays for routing. |

### Tasks

- [ ] **C-4.1** Helper `groupCatalogByUserFacing(catalog)` returning `Array<{ group, models: ModelEntry[] }>`. Dedupe by id within a group.
- [ ] **C-4.2** Render one section per group with the group displayName as header. Each model row keeps its existing layout.
- [ ] **C-4.3** Whitelist semantics: a checked model in the grouped section writes `{ provider: <canonical spec>, model: <id> }` to allowedModels — see C-5 for what canonical means.
- [ ] **C-4.4** Live verify: Models tab shows 4 sections (OpenAI, Anthropic, Local, Clemson). OpenAI section has 5 models (deduped from 10). Toggling a checkbox round-trips to allowedModels.
- [ ] **C-4.5** Commit.

---

## Phase C-5: Chat-tab routing for grouped providers

When a student picks an OpenAI/Anthropic model in the chat dropdown, the
underlying spec to route through depends on which creds are available.

### Files

| Path | Change |
|---|---|
| `src/model-provider-switch.ts` | `setModelProviderAndModel({modelProvider, model})` — when `modelProvider` is a group id (e.g. `'openai'`), resolve to a concrete member spec id at write time using a small lookup: prefer the student's active method, else the instructor's active method, else first member that has any credential. Write the resolved spec id into `container_configs.model_provider`. |
| `src/channels/playground/public/tabs/chat.js` | When the chat dropdown receives the grouped Models tab catalog, populate provider options from groups instead of spec ids. PUT `{ modelProvider: groupId, model }`. |
| `src/channels/playground/api/models.ts` | `providerAuth` Record now keyed by group id (OR across member specs' availability). Chat dropdown filter uses the group key. |

### Tasks

- [ ] **C-5.1** Implement the spec-resolution helper.
- [ ] **C-5.2** TDD: round-trip test — passing `{modelProvider:'openai', model:'gpt-5.5'}` resolves to `codex` when student has codex OAuth, `openai-platform` when student has only API key, etc.
- [ ] **C-5.3** Update chat.js dropdown population.
- [ ] **C-5.4** Update `models.ts` providerAuth shape to group ids.
- [ ] **C-5.5** Live verify: as a student with only openai-platform creds, picking gpt-5.5 in chat tab routes through `/openai-platform/` (check logs).
- [ ] **C-5.6** Commit.

---

## Out of scope (deferred)

- **Multi-class.** Still `DEFAULT_CLASS_ID = 'default'`. Multi-class is
  a separate plan.
- **A third Anthropic auth method (Anthropic Console OAuth).** Today's
  spec is Claude Code OAuth + API key. If/when Console OAuth is wired,
  it slots in as a third sub-row under Anthropic.
- **Owner-only LLM Providers card permissions.** TA sees the instructor
  view too, including the ability to flip Apply-to-class for the
  class. If you want TAs read-only, that's a separate restriction.

---

## Risks / invariants

- **Underlying spec ids stay separate.** Credential-proxy routing, per-
  user cred storage, and class-pool wiring all key by spec id. Grouping
  is a UI fold + a routing-resolution step at write time, not a
  storage merge.
- **`.env` migration is one-way.** Once owner-side creds exist, the
  resolver doesn't read `.env` for those providers. Document this in
  state.md after C-1 ships.
- **Apply-to-class is per-group.** It sets every member spec's
  `provideDefault=true` (broadcast on write — same pattern as the
  Class Controls form Phase 1 already uses).
- **Active-method ambiguity.** When a student has only one method
  connected, the "active" field may be unset. The resolver should
  default to whatever method has a credential when `active` is null —
  not 502.
- **Grey-out source of truth.** "Provided" greys based on the
  instructor's per-user creds for any member spec. If the instructor
  later disconnects all member creds, the Provided toggle silently
  stays checked in the saved config — the resolver returns null and
  the student call 502s. C-3 reads providedReady at form render, so
  the next instructor visit will show the toggle greyed out and
  prompt them to either reconnect or uncheck. Acceptable.
