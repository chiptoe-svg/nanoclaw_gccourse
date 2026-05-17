---
name: add-classroom-provider-auth
description: Install the per-student LLM provider auth subsystem — storage, resolver, OAuth routes, Home Providers card, Models status pill, Class Controls per-provider table. Layers on /add-classroom. Trunk prerequisites (registry + studentCredsHook + per-request invocation) are already in main. Triggers on "add classroom provider auth", "per-student provider auth", "student LLM credentials".
---

# Add Classroom Provider Auth

Installs the per-student LLM provider authentication layer for classroom deployments. With this skill, each student can connect their own Claude OAuth subscription or Codex API key; those per-student credentials are then used automatically at proxy time, burning the student's quota instead of the instructor's.

**This layers on `/add-classroom`.** Run that first if you haven't — it provides the `classroom_roster` table that this skill's resolver reads.

## What it adds

- **`src/student-provider-auth.ts`** — SQLite-backed store for per-student provider credentials (OAuth tokens + API keys), with TTL-aware OAuth refresh and policy enforcement (`allow`, `provideDefault`, `allowByo`).
- **`src/classroom-provider-resolver.ts`** — the `resolveStudentCreds` function that the credential proxy calls on every forwarded API request to inject the student's own token instead of the instructor's.
- **`src/channels/playground/api/provider-auth.ts`** — HTTP handlers for the student-facing provider connect/disconnect flow (`/provider-auth/<id>/start`, `/provider-auth/<id>/exchange`, `/api/me/providers/<id>`).
- **Patches to `src/channels/playground/server.ts`** — import block + route handlers for the above endpoints.
- **Patches to `src/index.ts`** — sentinel-bounded import block that registers `resolveStudentCreds` as the `studentCredsHook` and registers the provider specs (`claude-spec.js`, `codex-spec.js`).
- **Updated `src/db/classroom-roster.ts`** — adds `lookupRosterByAgentGroupId` helper used by the resolver.
- **Updated `src/channels/playground/api/class-controls.ts`** — v2 wrapped shape (`classes.default`) with per-provider policy (`allow`, `provideDefault`, `allowByo`), plus backwards-compat migration from the flat v1 shape.
- **Updated public JS/CSS** — Home tab "LLM Providers" card, Models tab status pill, `app.js` v2 class-controls shape, `chat.js` provider-filter fix.

## Prerequisites

- `/add-classroom` installed (`classroom_roster` table + class-token machinery in place).
- Trunk at or after commit `389e719`: `src/providers/auth-registry.ts`, `src/providers/claude-spec.ts`, `src/providers/codex-spec.ts` exist, and `src/credential-proxy.ts` exports `studentCredsHook` + `setStudentCredsHook`.

## Install

### Pre-flight (idempotent — skip if **all** of these are true)

- `src/student-provider-auth.ts` exists
- `src/classroom-provider-resolver.ts` exists
- `src/channels/playground/api/provider-auth.ts` exists
- `grep -q 'classroom-provider-auth:routes START' src/channels/playground/server.ts` exits 0
- `grep -q 'classroom-provider-auth:hook-registration START' src/index.ts` exits 0
- `grep -q 'classroom-provider-auth:providers-card START' src/channels/playground/public/tabs/home.js` exits 0

### 1. Fetch the classroom branch

```bash
git fetch origin classroom-x7-provider-auth
```

### 2. Copy new-file additions (files that don't exist in trunk)

```bash
git show origin/classroom-x7-provider-auth:src/student-provider-auth.ts       > src/student-provider-auth.ts
git show origin/classroom-x7-provider-auth:src/student-provider-auth.test.ts  > src/student-provider-auth.test.ts
git show origin/classroom-x7-provider-auth:src/classroom-provider-resolver.ts      > src/classroom-provider-resolver.ts
git show origin/classroom-x7-provider-auth:src/classroom-provider-resolver.test.ts > src/classroom-provider-resolver.test.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/provider-auth.ts      > src/channels/playground/api/provider-auth.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/provider-auth.test.ts > src/channels/playground/api/provider-auth.test.ts
```

### 3. Replace whole-file additions in shared classroom files

`classroom-roster.ts` gains `lookupRosterByAgentGroupId`; `class-controls.ts` gains the v2 wrapped shape + v1-migration logic; both gain new test files.

> **Note on `class-controls.test.ts`:** This file does not exist in trunk — the classroom branch adds it fresh. It tests only the v2 wrapped shape and v1-migration logic added in this step, so replacing both source and test wholesale is safe.

```bash
git show origin/classroom-x7-provider-auth:src/db/classroom-roster.ts               > src/db/classroom-roster.ts
git show origin/classroom-x7-provider-auth:src/db/classroom-roster.test.ts          > src/db/classroom-roster.test.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/class-controls.ts      > src/channels/playground/api/class-controls.ts
git show origin/classroom-x7-provider-auth:src/channels/playground/api/class-controls.test.ts > src/channels/playground/api/class-controls.test.ts
```

> **Compatibility note:** Replacing `class-controls.ts` changes the on-disk JSON shape the UI reads. The new version migrates old flat-shape `config/class-controls.json` files on read, so existing classroom installs that configured the file under the old format are handled transparently. Any custom edits to `class-controls.ts` itself (not the JSON) will be lost — inspect with `git diff HEAD src/channels/playground/api/class-controls.ts` before running this command if you've modified it locally.

### 4. Copy test-only addition to `ttl-map.ts`

The classroom branch adds an `entriesForTest()` iterator used by `student-provider-auth.test.ts`. Replace the file:

```bash
git show origin/classroom-x7-provider-auth:src/channels/playground/ttl-map.ts > src/channels/playground/ttl-map.ts
```

### 5. Apply sentinel-bounded patches to `src/index.ts`

The classroom branch adds:

1. `setStudentCredsHook` to the existing `credential-proxy.js` import.
2. A sentinel-bounded import block (lines that register `resolveStudentCreds` and the provider specs).
3. A `setStudentCredsHook(resolveStudentCreds)` call immediately after `startCredentialProxy(...)`.

Check first: `grep -q 'classroom-provider-auth:hook-registration START' src/index.ts` — if it exits 0, skip this step.

**a) Extend the `credential-proxy.js` import line to include `setStudentCredsHook`:**

In `src/index.ts`, find:

```ts
import { startCredentialProxy } from './credential-proxy.js';
```

Replace with:

```ts
import { startCredentialProxy, setStudentCredsHook } from './credential-proxy.js';
```

**b) Append the sentinel import block after that import line:**

```ts
// ── classroom-provider-auth:hook-registration START ───────────────────────
import { resolveStudentCreds } from './classroom-provider-resolver.js';
import './providers/claude-spec.js'; // registers claude
import './providers/codex-spec.js';  // registers codex
// ── classroom-provider-auth:hook-registration END ─────────────────────────
```

**c) Wire the hook — add the `setStudentCredsHook` call** immediately after the `startCredentialProxy(...)` line. In `src/index.ts` find:

```ts
  proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);
```

Add immediately after it (on its own line):

```ts
  setStudentCredsHook(resolveStudentCreds);
```

### 6. Apply sentinel-bounded patches to `src/channels/playground/server.ts`

The classroom branch adds two sentinel blocks:

1. An **import block** (lines that import from `./api/provider-auth.js`) after the existing import from `./http-helpers.js`.
2. A **routes block** (72 lines of route handlers) inside `handleRequest`, before the `// API` fallthrough.

Check first: `grep -q 'classroom-provider-auth:routes START' src/channels/playground/server.ts` — if it exits 0, skip this step.

**a) Extract and splice the import block:**

The import block goes immediately after the line:

```ts
import { parseCookie, readJsonBody, send } from './http-helpers.js';
```

Append after that line:

```ts
// ── classroom-provider-auth:imports START ──────────────────────────────────
import {
  handleProviderAuthStart, handleProviderAuthExchange,
  handleGetProviderStatus, handlePostApiKey, handleSetActive, handleDisconnect,
} from './api/provider-auth.js';
// ── classroom-provider-auth:imports END ────────────────────────────────────
```

**b) Extract and splice the routes block:**

The routes block goes immediately before the line:

```ts
  // API
  void route(req, res, url, method, session).catch((err) => {
```

Extract the exact block from the branch and splice it in:

```bash
# Grab the sentinel block (including the sentinel comment lines)
BLOCK=$(git show origin/classroom-x7-provider-auth:src/channels/playground/server.ts \
  | awk '/classroom-provider-auth:routes START/,/classroom-provider-auth:routes END/')

# Splice before "  // API" inside handleRequest.
# Use Python for reliable multi-line insertion (avoids sed delimiter collisions).
python3 - <<'PYEOF'
import pathlib, re, subprocess

block = subprocess.check_output(
    ['git', 'show', 'origin/classroom-x7-provider-auth:src/channels/playground/server.ts'],
    text=True,
)
# Extract the sentinel block
import re as _re
m = _re.search(
    r'(  // ── classroom-provider-auth:routes START.*?// ── classroom-provider-auth:routes END[^\n]*\n)',
    block, _re.DOTALL,
)
sentinel_block = m.group(1)

p = pathlib.Path('src/channels/playground/server.ts')
src = p.read_text()
if 'classroom-provider-auth:routes START' in src:
    print('Already applied — skipping')
else:
    anchor = '  // API\n  void route('
    assert anchor in src, f'Anchor not found in server.ts'
    src = src.replace(anchor, sentinel_block + '\n' + anchor, 1)
    p.write_text(src)
    print('Routes block spliced in')
PYEOF
```

### 7. Apply whole-file replacements for public JS/CSS

These files are playground UI only and carry no conflicting trunk changes. Replace all four wholesale:

```bash
git show origin/classroom-x7-provider-auth:src/channels/playground/public/app.js          > src/channels/playground/public/app.js
git show origin/classroom-x7-provider-auth:src/channels/playground/public/tabs/home.js    > src/channels/playground/public/tabs/home.js
git show origin/classroom-x7-provider-auth:src/channels/playground/public/tabs/models.js  > src/channels/playground/public/tabs/models.js
git show origin/classroom-x7-provider-auth:src/channels/playground/public/tabs/chat.js    > src/channels/playground/public/tabs/chat.js
git show origin/classroom-x7-provider-auth:src/channels/playground/public/style.css       > src/channels/playground/public/style.css
```

> `app.js` and `chat.js` update the class-controls shape reference from flat `providersAvailable[]` to the v2 `providers: { [id]: { allow, provideDefault, allowByo } }` map — required for the Models and Chat tabs to apply class-controls gating correctly with the new `class-controls.ts`.

### 8. Verify trunk prerequisites

Run these before building — they should all pass. If any fails, the skill can't complete (the classroom branch was developed against trunk as of `389e719`):

```bash
grep -q 'studentCredsHook' src/credential-proxy.ts \
  && echo 'OK: studentCredsHook present' \
  || echo 'FAIL: upgrade trunk to >= 389e719'

grep -q 'per-student-provider-auth:proxy-invocation START' src/credential-proxy.ts \
  && echo 'OK: proxy-invocation block present' \
  || echo 'FAIL: upgrade trunk to >= 389e719'

test -f src/providers/auth-registry.ts \
  && echo 'OK: auth-registry present' \
  || echo 'FAIL: upgrade trunk to >= 389e719'
```

### 9. Build + test + restart

```bash
pnpm run build
pnpm test
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

All three must be clean before using the skill in production.

## Verify

1. Sign in to the playground as owner (`/playground/` → authenticate).
2. **Home tab** — "LLM Providers" card is visible below Profile.
3. **Models tab** — each provider section has a status pill (e.g. "Provided by instructor", "Connect to use").
4. **Class Controls** — the per-provider policy table is visible (allow / provide-default / allow-BYO toggles per provider).
5. Sign in as a student — provider auth UI is visible; connecting a Codex API key routes through the student's key, not the instructor's.

## Removal

```bash
# Delete the new files
rm -f src/student-provider-auth.ts src/student-provider-auth.test.ts
rm -f src/classroom-provider-resolver.ts src/classroom-provider-resolver.test.ts
rm -f src/channels/playground/api/provider-auth.ts src/channels/playground/api/provider-auth.test.ts
rm -f src/channels/playground/api/class-controls.test.ts

# Restore trunk's versions of the modified shared files
git checkout HEAD -- src/db/classroom-roster.ts src/db/classroom-roster.test.ts
git checkout HEAD -- src/channels/playground/api/class-controls.ts
git checkout HEAD -- src/channels/playground/ttl-map.ts
git checkout HEAD -- src/channels/playground/public/app.js
git checkout HEAD -- src/channels/playground/public/tabs/home.js
git checkout HEAD -- src/channels/playground/public/tabs/models.js
git checkout HEAD -- src/channels/playground/public/tabs/chat.js
git checkout HEAD -- src/channels/playground/public/style.css

# Remove the sentinel blocks from index.ts and server.ts
sed -i '' '/classroom-provider-auth:hook-registration START/,/classroom-provider-auth:hook-registration END/d' src/index.ts
sed -i '' '/classroom-provider-auth:imports START/,/classroom-provider-auth:imports END/d' src/channels/playground/server.ts
sed -i '' '/classroom-provider-auth:routes START/,/classroom-provider-auth:routes END/d' src/channels/playground/server.ts

# Remove the setStudentCredsHook call from index.ts
sed -i '' '/setStudentCredsHook(resolveStudentCreds);/d' src/index.ts

# Revert the credential-proxy.js import line to remove setStudentCredsHook
# (edit src/index.ts manually: remove ", setStudentCredsHook" from the import)

# Build + restart
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart nanoclaw                # Linux
```

> On Linux, replace `sed -i ''` with `sed -i` (GNU sed doesn't take an empty string argument).
