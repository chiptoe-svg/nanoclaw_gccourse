---
name: add-classroom
description: Provision an instructor-owned bot that hosts N student agent groups on a single channel identity. Each student gets their own agent group, DM, persona, and a scoped playground. Wiki commits attributed to real students. Layered with /add-classroom-gws (Drive folders) and /add-classroom-auth (per-student ChatGPT subscription).
---

# Add Classroom (base)

Bulk-provision a class of N students against a single bot. The base
skill installs:

- `class-skeleton.ts` — bulk provisioner.
- Pair-handler integration that detects class students and stamps
  metadata (name, email, paired user_id) on the agent group.
- A short greeting message after each student pairs.
- Playground lockdown so students can edit their own persona but
  cannot change container.json, skills, or provider.
- Per-student git identity injection so wiki commits show the real
  student name + email.

Optional layered skills (run after the base is installed):

- `/add-classroom-gws` — Google Drive folder per student via the
  instructor's existing Google OAuth.
- `/add-classroom-auth` — per-student Codex OAuth so students burn
  their own ChatGPT subscription quota instead of the instructor's.

## Prerequisites

- `/add-agent-playground` should be installed. The classroom feature
  works without it, but the playground lockdown gate has nothing to
  do until the playground is wired in. The skill warns if absent.
- `/add-telegram` (or another DM-capable channel) installed and
  paired. The class feature uses the channel-agnostic pair-consumer
  registry, but you need at least one channel that handles wire-to
  pairings (Telegram is what's documented in the smoke-test runbook).

## Install

This skill copies the base classroom files from the
`origin/classroom` sibling branch and appends imports.

### Pre-flight (idempotent — safe to re-run)

Skip to **Provision** if all of these are already in place:

- `src/class-config.ts`, `src/class-pair-greeting.ts`,
  `src/class-playground-gate.ts`, `src/class-container-env.ts`,
  `scripts/class-skeleton.ts`, `scripts/class-skeleton-extensions.ts`
  exist
- `src/index.ts` contains `import './class-pair-greeting.js';`,
  `import './class-playground-gate.js';`, and
  `import './class-container-env.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 2. Copy the base classroom files

```bash
git show origin/classroom:src/class-config.ts            > src/class-config.ts
git show origin/classroom:src/class-config.test.ts       > src/class-config.test.ts
git show origin/classroom:src/class-pair-greeting.ts     > src/class-pair-greeting.ts
git show origin/classroom:src/class-playground-gate.ts   > src/class-playground-gate.ts
git show origin/classroom:src/class-container-env.ts     > src/class-container-env.ts
git show origin/classroom:src/class-container-env.test.ts > src/class-container-env.test.ts
git show origin/classroom:scripts/class-skeleton.ts      > scripts/class-skeleton.ts
git show origin/classroom:scripts/class-skeleton-extensions.ts > scripts/class-skeleton-extensions.ts
mkdir -p docs
git show origin/classroom:docs/class-setup.md            > docs/class-setup.md
mkdir -p plans
git show origin/classroom:plans/class.md                 > plans/class.md
git show origin/classroom:plans/class-smoke-test.md      > plans/class-smoke-test.md
```

### 3. Append the self-registration imports

Append these three lines to `src/index.ts` (skip lines already
present). They go in the same area as the `import './channels/index.js'`
and `import './modules/index.js'` blocks:

```typescript
import './class-pair-greeting.js';
import './class-playground-gate.js';
import './class-container-env.js';
```

### 4. Edit the skeleton extensions barrel

The base skill ships `scripts/class-skeleton-extensions.ts` as
EMPTY (no extensions). The gws and auth skills append their own
imports. If the file from step 2 has any imports already, leave
them — they're from a previously-installed layer.

If the file you copied has the gws import line, leave it. The
skill is idempotent and the import only takes effect when the
referenced file exists (i.e., gws is installed).

### 5. Build

```bash
pnpm exec tsc --noEmit
pnpm test
```

Both should be green. If `pnpm test` reports failures, diff against
`origin/classroom` to see what's drifted.

## Provision a class

```bash
pnpm exec tsx scripts/class-skeleton.ts \
  --count 16 \
  --names "Alice,Bob,Carol,Dave,Eve,Frank,Grace,Heidi,Ivan,Judy,Kenneth,Leo,Mia,Noor,Oscar,Pat" \
  --kb /srv/class-kb \
  --wiki /srv/class-wiki
```

This creates 16 `groups/student_<n>/` directories with starter
CLAUDE.md + CLAUDE.local.md + container.json (KB ro mount, wiki rw
mount), 16 `agent_groups` rows, 16 four-digit pairing codes via the
`wire-to` pairing flow, and a `class-roster.csv` mapping name ↔
folder ↔ pairing code.

KB and wiki paths must be in
`~/.config/nanoclaw/mount-allowlist.json` or the host will refuse
to spawn student containers.

See `docs/class-setup.md` for the full instructor README, including
KB/wiki dir setup, distributing pairing codes, and the verification
SQL.

## What students experience after pairing

Each student DMs the bot:

```
<their-pairing-code> <their-email>
```

The bot replies with a short greeting:

> Hi Alice! Welcome to class. Send /playground any time to customize
> my personality and style.

If `/add-classroom-gws` is installed, a second message follows with
their Drive folder URL. If `/add-classroom-auth` is installed, a
third message with their auth-link URL.

## Customize the greeting

The greeting text is hardcoded in `src/class-pair-greeting.ts`
(simple template literal — find and edit). Skills are file copies,
not opaque packages — edit freely after install.
