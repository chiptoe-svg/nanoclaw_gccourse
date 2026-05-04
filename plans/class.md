# Class feature — 16-student bot provisioning

Provision an instructor-owned NanoClaw bot that hosts N (default 16) student
agent groups on a single Telegram bot identity. Each student gets their own
agent group, DM, persona, Drive folder, and shared KB + wiki access. The
instructor stays global owner across all 16.

> **Status:** Phase 1 shipped in `3cc4e4e`. Phase 2 is in progress (uncommitted
> Dockerfile diff). This plan was reconstructed after a session crash from the
> README (`docs/class-setup.md`), the script (`scripts/class-skeleton.ts`),
> and the working-tree diff. Update phase checkboxes as work lands.

## Source-of-truth artifacts

- `docs/class-setup.md` — instructor-facing README (what the instructor does
  in GCP + on the host before running the script)
- `scripts/class-skeleton.ts` — bulk provisioner (Phase 1 deliverable)
- `data/class-config.json` — written by the skeleton script, read by the
  pair handler in Phase 3 (`driveParent`, `kb`, `wiki`, `students[]`)
- `class-roster.csv` — written by the skeleton script for distribution

## Phases

### Phase 1 — Skeleton script + instructor README ✅ (commit `3cc4e4e`)

- [x] `docs/class-setup.md` — instructor README covering service-account
      setup, parent Drive folder, KB dir, wiki git init, distribution flow
- [x] `scripts/class-skeleton.ts`:
    - [x] `--count`, `--names`, `--drive-parent`, `--kb`, `--wiki` CLI args
    - [x] Persists `data/class-config.json` for later phases
    - [x] Idempotent: skips existing `agent_groups` rows by folder
    - [x] Creates `groups/student_<n>/` with `CLAUDE.md` + `CLAUDE.local.md`
          + `container.json`
    - [x] `additionalMounts` for KB (ro) and wiki (rw) recorded in
          `container.json`
    - [x] Generates `wire-to` pairing code per student via `createPairing`
    - [x] Writes `class-roster.csv` for instructor distribution

### Phase 2 — Google Workspace tooling in container ✅ (uncommitted)

- [x] `container/Dockerfile`: pnpm-global install
      `@googleworkspace/cli@${GOOGLE_WORKSPACE_CLI_VERSION}` (pinned
      `0.22.5`).
- [x] Service-account credential plumbing — chose **Option A (mount)**.
      The credential-proxy design is for bearer-style API keys;
      service-account JWTs add complexity not worth it for V1.
- [x] `ContainerConfig.env: Record<string,string>` field added; threaded
      through `container-runner.buildContainerArgs` so per-group env vars
      (like `GOOGLE_APPLICATION_CREDENTIALS`) get injected at spawn.
- [x] `class-skeleton.ts`: new `--drive-creds <path>` arg (defaults to
      `/home/nano/.config/nanoclaw/class-drive.json` if present). When
      present, mounts the JSON RO at `/run/secrets/gw-creds.json` and
      sets `GOOGLE_APPLICATION_CREDENTIALS`.
- [x] `docs/class-setup.md` updated: mount-allowlist requirement,
      `--drive-creds` arg, container.json mount layout.
- [x] `pnpm exec tsc --noEmit` clean.
- [ ] Build: `./container/build.sh` (deferred — long op; user can run when
      ready to provision a real class).
- [ ] Smoke test: `gw drive list` from inside a student container against
      the parent folder (deferred — needs real GCP service account).
- [ ] Commit Dockerfile + container-config + container-runner +
      class-skeleton + docs (waiting on user signoff).

### Phase 3a — Pair handler: `<code> <email>` + wire-to dispatch ✅

**Surprise during implementation:** the `wire-to` pairing intent had no
handler before this phase. The `class-skeleton` script (Phase 1) generated
codes that, when consumed, registered the chat + paired user but never
wired the messaging group to its target agent group. Phase 3a fixed that.

- [x] `extractCode` / new `extractCodeAndEmail` accept either a bare 4-digit
      code OR `<code> <email>` (loose RFC-shape email regex). Existing
      "0349 thanks" rejection preserved.
- [x] `tryConsume` captures the email and stores it on
      `PairingRecord.consumed.email`.
- [x] Migration 015 adds `agent_groups.metadata TEXT` (nullable JSON blob).
      `getAgentGroupMetadata(id)` / `setAgentGroupMetadataKey(id, key, value)`
      helpers. `AgentGroup.metadata` is optional on the type so existing
      literal constructions don't need a migration of their own.
- [x] `src/class-config.ts` reads `data/class-config.json`,
      `findClassStudent(folder)` lookup helper.
- [x] Telegram pairing interceptor now handles `wire-to`:
      looks up `agent_group` by folder, creates `messaging_group_agents`
      row with `init-first-agent`-style defaults (engage-pattern '.' for DMs,
      mention-only for groups), persists `student_email` + `student_name`
      on the agent group's metadata when the folder is in `class-config`.
- [x] Tests added for the new email-extraction paths; full suite
      (312 / 312) green.

### Phase 3b — Drive folder creation on pair (next)

- [ ] Host-side `class-drive.ts` wrapping the `gw` CLI (or googleapis SDK)
      with the service-account JSON: `createStudentFolder(parent, n, email)`
      → returns Drive folder ID, shares as Editor.
- [ ] In the pair interceptor: when `wire-to` + class config + email
      capture all align, call `createStudentFolder`, then
      `setAgentGroupMetadataKey(ag.id, 'drive_folder_id', id)`.
- [ ] Append a `/workspace/drive/` mount to the student's `container.json`
      pointing at the host-side rclone mount of the Drive folder
      (or stage files via the agent-runner; decide in this phase — rclone
      is heavier but gives the agent a real filesystem).
- [ ] Idempotency: re-pair with same email is no-op on the Drive side.
- [ ] Decision: do we run the host-side Drive call inline in the
      interceptor (blocking the pairing confirmation) or hand off to a
      background job? Inline is simpler, but a slow Drive API call would
      delay the user's "paired!" message. Lean inline for V1, log timing.

### Phase 4 — Per-student git identity for wiki attribution

- [ ] At container spawn, set `git config user.name student_<n>` and
      `user.email student_<n>@class.local` inside the container's wiki
      mount, OR via `GIT_AUTHOR_*` env vars in `container-runner.ts`.
      Env-var approach is cleaner — no in-container state.
- [ ] Verify: a wiki commit from `student_07`'s container shows
      `student_07 <student_07@class.local>` in `git log`.

### Phase 5 — Scoped playground

- [ ] Existing `/playground` skill currently scopes by agent group. For the
      class case, students should reach the playground via DM and edit
      *their own* persona only. Audit: confirm playground already enforces
      per-agent-group scope (it does — magic-link auth is per-group).
- [ ] Restrict the playground to `CLAUDE.local.md` editing only — the
      shared `CLAUDE.md` (which `@./.claude-shared.md` includes) must not
      be student-editable. Likely a config flag on the playground:
      `editableFiles: ['CLAUDE.local.md']`.
- [ ] Add a class-wide `agent_group_members` row so the instructor can
      access every student playground without owner override (already
      have global owner; this is just for cleanliness in audit logs).

### Phase 6 — Welcome message + privacy notice

- [ ] After successful pair + Drive folder creation, the bot sends:
    - Greeting tagged to the student's name (resolved from `class-config.json`)
    - Privacy notice from `docs/class-setup.md` ("conversations visible to
      instructor", "wiki contributions shared", etc.)
    - Pointer to `/playground` for persona customization.
- [ ] Source the message text from a single template file
      (`container/skills/welcome/class-welcome.md`?) so the instructor can
      edit it without code changes.

### Phase 7 — Verification + end-to-end smoke

- [ ] Run `class-skeleton.ts --count 2 --names "Alice,Bob" --drive-parent
      <test-folder> --kb /tmp/kb --wiki /tmp/wiki` against a throwaway
      Drive folder.
- [ ] DM both pairing codes from two real Telegram accounts; confirm:
    - Drive folder appears, shared with the student email.
    - `/workspace/drive/` is writable from inside container.
    - Wiki commits attributed correctly.
    - `/playground` edits land in `CLAUDE.local.md` only.
    - Instructor's transcript view shows both students' conversations.
- [ ] Verifier SQL from README returns expected rows.
- [ ] Update `docs/class-setup.md` with any gotchas discovered.

### Phase 8 — Bundle as `/setup-class` skill (optional)

- [ ] Wrap Phases 1 + manual setup steps from the README into an
      operational skill so instructors don't read a doc — they run a skill
      that walks through GCP setup, KB/wiki dir creation, then invokes
      `class-skeleton.ts`.
- [ ] Defer until Phases 1–7 are stable.

## Open questions

1. **Service-account vs. per-student OAuth for Drive.** Current design uses
   a single service account that owns folders and shares with the student.
   Alternative: each student authorizes via OAuth so files belong to *them*.
   Service account is simpler to provision (no per-student auth dance) and
   matches the README. Sticking with service account.
2. **Wiki conflict resolution.** With 16 students writing concurrently to
   the same git repo, conflicts will happen. V1: last-writer-wins, agent
   handles `git pull --rebase` retries. V2 if needed: a serializing wiki
   service that linearizes writes.
3. **Per-student container limits.** 16 simultaneous containers on one
   host is fine for an instructor laptop; might not be fine on a Pi. Note
   in README, don't enforce.

## Non-goals (explicit)

- Per-student per-channel isolation beyond Telegram DM. (No Slack, no email.)
- Grade book, attendance, or LMS integration.
- Real-time class-wide broadcasts. (Instructor can do this manually by DMing
  each student or scripting it; not building first-class.)
