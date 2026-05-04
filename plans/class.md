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

### Phase 3c — rclone mount + Doc-only MCP (next)

**Architectural decision.** A general "Drive MCP" (list/read/write) duplicates
what bash + a real filesystem already do, and it duplicates them *worse* —
extra tool-roster weight, extra latency, extra auth surface, no semantic
gain. Codex (the agent provider this install runs most of the time) is
bash-first by design; wrapping `cat`/`ls`/`grep -r` in MCP makes Codex worse
at being Codex. So:

1. **rclone-mount the student's specific Drive subfolder** at
   `/workspace/drive/` inside the container. The instructor's full-Drive
   OAuth stays on the host; the container only sees one folder via bind
   mount. Codex uses bash, Claude uses Read/Write/Grep — both work because
   it's a real path.
2. **Doc-only MCP** for the one thing rclone can't do: Google Docs are
   pointer files in rclone, not text. Two tools, host-side, scoped per
   agent group: `drive_doc_read_as_markdown(name)`,
   `drive_doc_write_from_markdown(name, markdown)`. Anything else (list,
   move, upload, search by content) goes through the rclone mount.

**Why one rclone process for the class, not 16.** rclone supports
`--drive-root-folder-id <PARENT>` to anchor the visible tree at the class
parent folder. One mount, one fuse process; each student's container
bind-mounts only its own subfolder by name.

**3c.1 — rclone host-side mount (instructor-run, one-time)**

- [ ] `docs/class-setup.md`: install `rclone`, `rclone config` to create a
      remote (call it `class-drive`) reusing the existing OAuth at
      `~/.config/gws/credentials.json` if rclone can be pointed at it; if
      not, walk through `rclone authorize drive` for a fresh refresh
      token. Set `--drive-root-folder-id <classConfig.driveParent>` on
      the remote.
- [ ] Systemd user unit (`docs/class-setup.md` snippet):
      `rclone mount class-drive: ~/nanoclaw-drive-mount/
       --vfs-cache-mode writes --dir-cache-time 30s
       --poll-interval 15s` so newly-created student folders show up
      promptly after Phase 3b runs.
- [ ] Add `~/nanoclaw-drive-mount/` (recursive) to the mount allowlist at
      `~/.config/nanoclaw/mount-allowlist.json`.

**3c.2 — per-student bind mount in class-skeleton**

- [ ] Folder name on disk under the rclone view is
      `<studentFolder> — <studentName>` (em dash, matches
      `createStudentFolder` in `src/class-drive.ts`). class-skeleton
      knows both at provision time, so write the mount into
      `container.json` at skeleton time — no pair-time mutation needed:
      ```
      { "hostPath": "<HOME>/nanoclaw-drive-mount/<folder> — <name>",
        "containerPath": "/workspace/drive", "readonly": false }
      ```
- [ ] New `--drive-mount-root` CLI flag (default `~/nanoclaw-drive-mount`)
      so non-default rclone mount paths work.
- [ ] Idempotent: re-running skeleton with new flags rewrites
      container.json mounts.

**3c.3 — Doc-only MCP server (after 3c.1+3c.2 prove rclone path works)**

- [ ] Two tools only: `drive_doc_read_as_markdown`,
      `drive_doc_write_from_markdown`.
- [ ] Host-side server, single process, authenticates the caller by an
      agent-group token injected into container env at spawn (mirror the
      credential-proxy pattern). Server looks up `drive_folder_id` from
      `agent_groups.metadata`; all Doc operations are scoped to that
      folder's children.
- [ ] Wire into `mcpServers` in the student's `container.json` only when
      `drive_folder_id` is present on the agent group's metadata.
- [ ] Skip if the rclone mount + Codex's bash + the agent's existing
      ability to use the Drive UI cover the actual use cases. Reassess
      after Phase 7 smoke test.

**Explicitly NOT building (rejected):**
- ~~General-purpose Drive MCP (list/read/write/grep)~~ — duplicates the
  filesystem rclone gives us, makes Codex worse.
- ~~Read/Write/Edit/Grep MCP "for Codex"~~ — Codex is bash-first by
  intent; `apply_patch` + shell already cover this. MCP wrappers add
  prompt overhead with no functional gain. The win for MCPs is things
  bash *can't* do.

### Phase 4 — Per-student git identity for wiki attribution ✅

Pair-time captures already give us the real student identity
(`agent_groups.metadata.student_name` from class config + `student_email`
from the `<code> <email>` pairing). Inject those as
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars at container spawn — better
than the original synthetic `student_07@class.local` plan because
`git log` shows actual humans the instructor recognizes.

- [x] `gitAuthorEnvFromMetadata(metadata)` pure helper in
      `src/container-runner.ts`. Emits 4 env pairs only when **both**
      name and email are present and non-empty (whitespace trimmed,
      non-string values ignored). Partial attribution would be worse
      than git's default error.
- [x] `buildContainerArgs`: looks up `getAgentGroupMetadata(agentGroup.id)`
      at spawn, pushes the env pairs through. No-op for non-class
      groups (empty metadata → empty array).
- [x] 7 unit tests covering present, missing-name, missing-email,
      empty metadata, whitespace-only, trimming, defensive non-string.
- [x] `pnpm exec tsc --noEmit` clean, 319/319 tests green.
- [ ] End-to-end verify deferred to Phase 7: a real wiki commit from
      Alice's container should show `Alice Chen <alice@school.edu>`
      in `git log`.

### Phase 5 — Scoped playground ✅

Per-agent-group scoping was already in place via magic-link auth, so the
audit step was a no-op. The actual lockdown is server-side gating on the
draft mutation endpoints — return 403 from the file PUT, skills PUT, and
provider PUT when the draft's target is a provisioned class student.
The persona endpoint (`PUT /api/drafts/:folder/persona`, used by the
"Edit Persona" pane) stays open. Students customize personality;
instructor controls everything else.

- [x] `isClassStudentFolder(folder)` helper in `src/class-config.ts`.
      Tested: present, absent, no class provisioned.
- [x] `isClassStudentDraft(draftFolder)` helper in
      `src/channels/playground.ts` — strips the `draft_` prefix and
      delegates. Returns false (not a security failure) for
      non-draft inputs so existing routes don't change behavior.
- [x] 403 gate on file PUT, skills PUT, provider PUT for class
      drafts. GETs remain open (reading shared CLAUDE.md is fine).
- [x] applyDraft already only copies `CLAUDE.local.md` and
      `container.json` back to the target — even pre-gate, a student
      could not have written a `CLAUDE.md` that escaped to production.
      The container.json PUT path was the actual exposure (skills,
      provider, mounts via the file editor) and is now closed.
- [x] 8 unit tests for the new helper. `pnpm exec tsc --noEmit`
      clean, 327/327 tests green.
- [ ] Class-wide `agent_group_members` row for the instructor — defer.
      Owner role already grants access to every group; this was only
      for audit-log cleanliness.

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
