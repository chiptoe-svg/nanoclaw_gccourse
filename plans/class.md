# Class feature — 16-student bot provisioning

Provision an instructor-owned NanoClaw bot that hosts N (default 16) student
agent groups on a single Telegram bot identity. Each student gets their own
agent group, DM, persona, Drive folder, and shared KB + wiki access. The
instructor stays global owner across all 16.

> **Status:** Phases 1 + 2 + 3a shipped (`3cc4e4e`, `273d92c`, `6248293`).
> Phase 2's service-account assumptions reverted in `f790913` ahead of an
> OAuth-based 3b. Phase 3b in progress (uncommitted: `src/class-drive.ts`,
> telegram pairing call, `googleapis` dep). Update phase checkboxes as work
> lands.

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

### Phase 2 — per-group container env infra ✅ (commit `6248293` + revert `f790913`)

Original scope was "install `@googleworkspace/cli` + mount a service-account
JSON into student containers." `f790913` walked back the service-account
parts because the instructor already has working user-OAuth at
`~/.config/gws/` (drive/docs/sheets/slides/gmail scopes, refresh token), so
(a) the auth model was wrong and (b) Drive ops belong host-side, not in the
container. What stays from Phase 2:

- [x] `ContainerConfig.env: Record<string,string>` field, threaded through
      `container-runner.buildContainerArgs` so per-group env vars get
      injected at spawn. Keeping this — useful for any per-group env need.

What was reverted (do **not** redo):

- [x] ~~`@googleworkspace/cli` Dockerfile install~~ — Drive ops moved to host.
- [x] ~~`--drive-creds` CLI flag + service-account mount + `GOOGLE_APPLICATION_CREDENTIALS`~~
      — replaced by Phase 3b's host-side OAuth path.

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

### Phase 3b — Drive folder creation on pair (in progress, uncommitted)

Auth model: instructor's existing user-OAuth at
`~/.config/gws/credentials.json` (left behind by `taylorwilsdon/google_workspace_mcp`
via `/add-gmail-tool` / `/add-gcal-tool`). Host-side only — the refresh
token is full-Drive scope, so we don't expose it to containers.

- [x] `src/class-drive.ts`: loads `~/.config/gws/credentials.json`, builds
      a `googleapis` Drive v3 client with refresh-token auth, exports
      `createStudentFolder({ parentFolderId, studentFolder, studentName,
      studentEmail })` → `{ folderId, folderUrl, created, shared }`.
      Idempotent on both axes (folder lookup by name under parent;
      permission check before re-granting). `sendNotificationEmail: false`
      so Google's notice doesn't race the bot's welcome DM.
- [x] `package.json`: add `googleapis@171.4.0` (released 2026-02-05, well
      past `minimumReleaseAge: 4320`).
- [x] Pair interceptor (`src/channels/telegram.ts`): after persisting
      `student_email` + `student_name`, look up class config + agent
      group metadata; if email is captured, `driveParent` is configured,
      and no `drive_folder_id` is already set, call `createStudentFolder`
      inline, then `setAgentGroupMetadataKey` for `drive_folder_id` +
      `drive_folder_url`. Drive errors are logged but don't fail pairing.
- [x] Decision: inline (not background). Drive call happens before pairing
      confirmation so the welcome message can include the folder URL.
      Re-pair retries on failure.
- [x] `pnpm exec tsc --noEmit` clean. `pnpm test` 312/312 green.
- [ ] Manual verification with the instructor's real OAuth + a throwaway
      parent folder (deferred to Phase 7 smoke test).
- [ ] Commit `src/class-drive.ts` + telegram.ts diff + package.json +
      pnpm-lock.yaml (waiting on user signoff).

### Phase 3c — Folder-scoped Drive MCP tool in container (next)

Phase 3b creates the folder host-side. Phase 3c gives the student's agent
a *scoped* MCP tool that can read/write only that folder — no broader Drive
access. The instructor's full-scope OAuth never leaves the host.

- [ ] Decide shape: thin host-side MCP server (one per host, takes a
      folder ID per request) vs. spawning a per-container scoped server.
      Lean: single host-side MCP that authenticates the caller by agent
      group ID and looks up the folder ID from `agent_groups.metadata`.
- [ ] Tool surface (minimum viable): `drive_list_files`, `drive_read_file`,
      `drive_write_file`, `drive_create_doc`. All implicitly scoped to the
      student's folder; no file-ID parameter that escapes the folder tree.
- [ ] Wire into the agent-runner's MCP registry; gate on
      `agent_groups.metadata.drive_folder_id` being set.
- [ ] Document in `docs/class-setup.md` what the student's agent can and
      can't do with Drive.

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
