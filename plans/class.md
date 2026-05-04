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

### Phase 3 — Pair handler: `<code> <email>` + lazy Drive folder

- [ ] Extend the wire-to pair handler to accept `<code> <email>` (currently
      just `<code>`). On match:
    1. Validate code (existing path).
    2. Validate email format.
    3. Pair the Telegram chat → `student_<n>` agent group (existing path).
    4. **New:** if `agent_groups.folder` matches `student_*` AND
       `data/class-config.json` exists, call the Drive provisioner:
       create `<driveParent>/student_<n>/`, share with the student's
       email as Editor, store the folder ID on the agent group.
    5. Append a `/workspace/drive/` mount to the student's `container.json`
       pointing at the new Drive folder ID (via `gw drive mount` or rclone
       — pick one in this phase).
    6. Send the welcome message (Phase 6).
- [ ] Persist `drive_folder_id` and `student_email` on the agent group.
      Schema decision: add columns vs. JSON blob in an existing column.
      Lean toward a small migration adding `agent_groups.metadata JSON`
      since this is the third feature wanting per-group metadata.
- [ ] Idempotency: if a student re-sends `<code> <email>`, don't double-create
      the Drive folder; reuse existing.

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
