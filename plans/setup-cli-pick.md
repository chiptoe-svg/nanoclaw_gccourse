# Setup-CLI Picker — Integration Plan

## Goal

Wire the `setup/lib/setup-cli/` registry (already committed) into the existing setup flow so:

1. The setup-time CLI invocations (handoff on failure, headless utility) go through the registry instead of hardcoded `claude` binary calls.
2. The user is asked once which CLI to use (Claude Code, OpenAI Codex, …), with the choice persisted to `.env` as `NANOCLAW_SETUP_CLI`.
3. README Quick Start reflects dual-CLI support honestly.

## Current state (as of commit `bb26617`)

**Done — framework + adapters:**

| File | Purpose |
|---|---|
| `setup/lib/setup-cli/types.ts` | `SetupCli` interface (binary, isInstalled, isAuthenticated, installScript, headless(prompt), handoff(prompt)) + `SpawnArgs` (argv, stdin, output) |
| `setup/lib/setup-cli/claude.ts` | `claudeCli` — Claude Code adapter |
| `setup/lib/setup-cli/codex.ts` | `codexCli` — OpenAI Codex adapter (`codex exec` headless, `codex [PROMPT]` handoff) |
| `setup/lib/setup-cli/index.ts` | Registry with `listSetupClis()`, `getSetupCli(name)`, `resolveSetupCli()` |
| `setup/lib/setup-cli/index.test.ts` | 11 tests covering both adapters' argv shapes and registry behavior |

**Selection precedence in `resolveSetupCli()`:**

1. `NANOCLAW_SETUP_CLI` env var (if set + adapter exists + installed)
2. First registered adapter that's installed (Claude first)
3. `null` if nothing works

**Untouched (still hardcodes `claude` binary) — work for this plan:**

| File | Hardcoded calls | Consumers |
|---|---|---|
| `setup/lib/tz-from-claude.ts` | `execSync('command -v claude')` (line 24), `spawn('claude', ['-p', ...])` (line 89) | `setup/auto.ts` |
| `setup/lib/claude-handoff.ts` | `execSync('command -v claude')` (line 160), `spawn('claude', ...)` (lines 94, 259) | `setup/auto.ts`, `setup/lib/runner.ts`, `setup/lib/windowed-runner.ts`, `setup/migrate.ts`, `setup/channels/teams.ts` |
| `setup/lib/claude-assist.ts` | `execSync('command -v claude')` (line 137), `claude auth status` (146), `setup/install-claude.sh` invocation (164), `spawn('claude', ...)` (388) | `setup/migrate.ts`, transitively used by `claude-handoff.ts` |
| `setup/install-claude.sh` | Pure bash; only relevant for Claude. Codex has no scriptable installer in this fork. | called by `claude-assist.ts` |
| `nanoclaw.sh` | No direct Claude reference; the failure handoff happens via `setup:auto` which uses the libs above | n/a |
| `README.md` Quick Start | Says "Claude Code is invoked automatically" | n/a |

**Tests baseline:** `pnpm test` → 466/466 passing.

## Phases

Each phase ends with `pnpm run build` + `pnpm test` clean and a focused commit. **Do not collapse phases** — incremental commits make rollback cheap if a setup-flow regression surfaces only on real-world install.

---

### Phase A — Refactor `tz-from-claude.ts` (smallest consumer; warm-up)

**Why first:** smallest file, single consumer, clear win/loss boundary. If this works, the bigger refactors follow the same shape.

**Files:**

- Rename `setup/lib/tz-from-claude.ts` → `setup/lib/tz-from-cli.ts` (keep file name honest about what it does)
- Update import in `setup/auto.ts:54`

**Changes:**

1. New file replaces hardcoded `claude` invocation:
   ```ts
   import { resolveSetupCli } from './setup-cli/index.js';

   export function setupCliAvailable(): boolean {
     return resolveSetupCli() !== null;
   }

   export async function resolveTimezoneViaCli(userInput: string): Promise<string | null> {
     const cli = resolveSetupCli();
     if (!cli) return null;
     const spawnArgs = cli.headless(`Convert "${userInput}" to a single IANA tz string. Reply ONLY the zone, nothing else.`);
     // ... existing spawn logic, replacing 'claude' with cli.binary and ['-p', ...] with spawnArgs.args
   }
   ```

2. Rename exports:
   - `claudeCliAvailable` → `setupCliAvailable`
   - `resolveTimezoneViaClaude` → `resolveTimezoneViaCli`

3. Update `setup/auto.ts:54` import + call sites.

**Verification:**

- `pnpm exec tsc --noEmit` clean
- `pnpm test` 466/466
- Manual: temporarily drop `claude` from PATH (e.g. `PATH=/usr/bin pnpm run setup:auto`), confirm tz resolution falls through to codex if installed.

**Commit:** `refactor(setup): tz-from-cli — use setup-cli registry instead of hardcoded claude`

---

### Phase B — Refactor `claude-handoff.ts` → `cli-handoff.ts`

**Why before assist:** handoff is what the user sees on step failure. Assist is the underlying mechanism. Fixing handoff first lets us validate the picker UX with one failure path.

**Files:**

- Rename `setup/lib/claude-handoff.ts` → `setup/lib/cli-handoff.ts`
- Update imports in: `setup/auto.ts:42`, `setup/lib/runner.ts:21`, `setup/lib/windowed-runner.ts:21`, `setup/migrate.ts:33`, `setup/channels/teams.ts:41`

**Changes:**

1. The internal `isClaudeUsable()` helper (line 158) becomes `isSetupCliUsable()` and consults `resolveSetupCli()`.
2. `offerClaudeHandoff(ctx)` becomes `offerSetupCliHandoff(ctx)` — internally:
   ```ts
   const cli = resolveSetupCli();
   if (!cli) return false;
   const spawn = cli.handoff(buildSystemPrompt(ctx));
   const child = spawn(cli.binary, spawn.args, { stdio: [spawn.stdin, spawn.output, spawn.output] });
   ```
3. `offerClaudeOnFailure` → `offerSetupCliOnFailure` (same semantic)
4. Public exports updated (and the 5 consumer imports renamed).
5. The Markdown / TUI prompts in `buildSystemPrompt` and `buildFailureSystemPrompt` should be **CLI-agnostic** in wording — no "Claude Code" hardcoded strings. The system prompt should reference what the failure was, not which CLI is reading it.

**Edge case: prompt format differences.**

- Claude Code's `claude [PROMPT]` interprets the prompt as the opening user message in the TUI.
- Codex's bare `codex [PROMPT]` does the same.
- Both spawn an interactive session that exits cleanly when user types `/exit` (Claude) or `Ctrl-C` / `:q` style (Codex). No special handling needed at the spawn level.

**Verification:**

- Build + tests clean.
- Manual: artificially fail a setup step (set `NANOCLAW_SKIP_FORCE_FAIL=1` or similar — see `nanoclaw.sh:NANOCLAW_SKIP`), confirm picker → handoff happens via the chosen CLI.

**Commit:** `refactor(setup): cli-handoff — registry-aware setup-step handoff`

---

### Phase C — Refactor `claude-assist.ts` → `cli-assist.ts`

**Files:**

- Rename `setup/lib/claude-assist.ts` → `setup/lib/cli-assist.ts`
- Update imports in `setup/migrate.ts:32`, internal use from `cli-handoff.ts`

**Changes:**

1. `isClaudeInstalled()`, `isClaudeAuthenticated()`, `ensureClaudeReady()` become `isSetupCliInstalled()`, `isSetupCliAuthenticated()`, `ensureSetupCliReady()` — all consult `resolveSetupCli()`.
2. `ensureSetupCliReady()`'s install-script invocation respects the adapter's `installScript` field:
   ```ts
   const cli = resolveSetupCli();
   if (cli?.installScript) {
     const code = spawnSync('bash', [cli.installScript], { ... });
   } else {
     // No scriptable installer; tell the user to install manually
     return false;
   }
   ```
3. `offerClaudeAssist(ctx)` → `offerSetupCliAssist(ctx)`. The pre-built `${binary} ...` command line that's offered to the user (the editable pre-fill) needs to be rebuilt from the chosen CLI's adapter shape.

**Edge case: STEP_FILES + BIG_PICTURE_FILES context lists.**

These are file lists that get read and pasted into the prompt for context. They're CLI-agnostic — same lists work for any CLI. Keep as-is.

**Verification:** same shape as Phase B.

**Commit:** `refactor(setup): cli-assist — registry-aware setup helper`

---

### Phase D — Picker prompt + `.env` persistence

**Where:** `setup/auto.ts`, near the start of the flow before any step that might invoke a CLI.

**Behavior:**

1. **Already-configured path:** if `NANOCLAW_SETUP_CLI` is set (env or `.env`), validate it's installed; if so, skip the prompt.
2. **Auto-pick path:** exactly one CLI installed → no prompt; just persist `NANOCLAW_SETUP_CLI=<that-one>` and continue.
3. **Picker path:** zero or two-or-more installed → ask via `@clack/prompts` `select`:
   ```ts
   const installed = listSetupClis().filter((c) => c.isInstalled());
   if (installed.length === 0) {
     // Offer to install Claude Code via setup/install-claude.sh; otherwise tell user
     // to install one of the listed CLIs and re-run setup.
   } else if (installed.length === 1) {
     // Auto-pick, persist, continue silently.
   } else {
     const choice = await select({
       message: 'Which coding-assistant CLI should setup use for diagnostics?',
       options: installed.map((c) => ({ value: c.name, label: c.displayName })),
     });
     // Persist to .env
   }
   ```
4. **Persistence:** append/update the `.env` line `NANOCLAW_SETUP_CLI=<name>`. Reuse the same env-write helper the rest of `setup/auto.ts` uses for `TZ` etc. (search `setup/auto.ts` for `writeEnvVar` or similar).

**Verification:**

- Run `bash nanoclaw.sh` end-to-end from a clean machine that has both CLIs installed. Picker shows; choice persists; failure handoff uses the chosen CLI.
- Then re-run setup; picker is skipped (already configured).
- Then `unset NANOCLAW_SETUP_CLI` + `sed -i '/^NANOCLAW_SETUP_CLI=/d' .env` + re-run; picker shows again.

**Commit:** `feat(setup): picker prompt for setup CLI (Claude Code or Codex)`

---

### Phase E — README + docs update

**Files:**

- `README.md` Quick Start section
- `AGENTS.md` — already mentions both Claude Code and Codex; verify it still reads correctly after the rename
- `docs/setup-flow.md` if it exists — check for stale `claude-handoff` / `claude-assist` references

**README change** (replacing the previously-suggested rewrite from this session):

```markdown
## Quick Start

```bash
git clone https://github.com/chiptoe-svg/nanoclaw_gccourse.git nanoclaw-v2
cd nanoclaw-v2
bash nanoclaw.sh
```

`nanoclaw.sh` walks you from a fresh machine to a named agent you can message. It installs Node, pnpm, and Docker if missing, configures the local credential proxy, builds the agent container, and pairs your first Telegram chat. If a step fails, your chosen coding-assistant CLI (Claude Code or OpenAI Codex; setup asks which on first run) is invoked automatically to diagnose and resume from where it broke.

After setup, opt into the optional pieces this fork is built around:

- `/add-admintools` — Telegram admin commands (`/auth`, `/model`, `/provider`)
- `/init-first-agent` — bootstrap your first agent and pair it to a Telegram chat
- `/add-karpathy-llm-wiki` — persistent wiki knowledge base per agent group
- `/add-classroom` — provision a multi-tier class
- Other channels via `/add-discord`, `/add-slack`, `/add-whatsapp`, etc.
```

**Commit:** `docs(readme): mention dual-CLI setup support (Claude Code or Codex)`

---

### Phase F — End-to-end smoke test

Not a commit — a manual verification step before merging to origin/main.

**Test matrix:**

| Scenario | Expected |
|---|---|
| Fresh clone, no CLI installed | Setup detects, offers to run `install-claude.sh`. User declines → setup tells them to install one and re-run. |
| Only Claude installed | No picker; auto-picks Claude; persists `NANOCLAW_SETUP_CLI=claude`. |
| Only Codex installed | No picker; auto-picks Codex; persists `NANOCLAW_SETUP_CLI=codex`. Failure handoff invokes `codex [PROMPT]`. |
| Both installed, first run | Picker shows; user picks one; persists choice. |
| Both installed, second run | No picker; uses persisted choice. |
| `NANOCLAW_SETUP_CLI=codex` in env, only Claude installed | Falls back to Claude; warns about misconfig but doesn't fail. |
| Step failure during setup | Handoff happens via chosen CLI; user types `/exit` or equivalent; setup resumes. |

If any of these surface a bug, file as a follow-up commit before announcing the feature.

---

## Estimated effort

- Phase A: 30 min
- Phase B: 1 hour
- Phase C: 1 hour
- Phase D: 1 hour (picker UX + env-write helper hookup)
- Phase E: 15 min
- Phase F: 30 min manual

**Total: ~4 hours of focused work.** Should be doable in one fresh session.

## Resumability cues for a future Claude

- The framework commit is `bb26617` on `main`.
- This plan file (`plans/setup-cli-pick.md`) is the source of truth for what's left.
- After each phase commit, tick the corresponding `[x]` box below.
- If you find a phase has subtle complications not captured here, **update this file before continuing** so the next session inherits the discovery.

## Progress

- [x] Framework: `setup/lib/setup-cli/` registry + Claude + Codex adapters + tests
- [ ] Phase A: `tz-from-claude.ts` → `tz-from-cli.ts` (registry-aware)
- [ ] Phase B: `claude-handoff.ts` → `cli-handoff.ts`
- [ ] Phase C: `claude-assist.ts` → `cli-assist.ts`
- [ ] Phase D: Picker prompt + `.env` persistence
- [ ] Phase E: README + docs update
- [ ] Phase F: End-to-end smoke test
