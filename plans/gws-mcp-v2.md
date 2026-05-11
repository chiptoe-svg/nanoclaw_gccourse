# Phase 13.5 — Google Workspace MCP V2 tool surface

V1 (Phases 13.2–13.4) shipped two tools that close the rclone gap for
Google **Docs**:

- `drive_doc_read_as_markdown`
- `drive_doc_write_from_markdown`

V2 expands the surface to Sheets, Calendar, Drive listing, and (with
careful scoping) Gmail. Each cluster is a **separate sub-phase**, only
landed when a concrete use case shows up. This file is the shared
design doc the per-sub-phase plans will reference, so the four
clusters stay consistent on auth, scoping, error shape, and test
pattern.

## Why a shared plan

Three things tend to drift across multiple-tool feature work:

1. **Argument shape conventions** — `file_id` vs `fileId`, optional
   create flags, what counts as a "name." V1 settled on snake_case in
   the host validators (`file_id`, `create_if_missing`) with the
   container shim passing through unchanged. V2 inherits that.
2. **Role enforcement** — every tool needs a row in the role matrix
   below, decided once rather than re-litigated per PR.
3. **Test pattern** — V1 established host-side `vitest` tests that
   mock `@googleapis/*` clients + bun:test container shims that mock
   `fetch`. New tools follow the same two-layer pattern.

The infra carries forward unchanged: host `gws-mcp-tools.ts` →
`gws-mcp-server.ts` dispatch → `gws-mcp-relay.ts` HTTP →
`X_NANOCLAW_AGENT_GROUP` attribution → `getGoogleAccessTokenForAgentGroup`
→ per-student or instructor token. Each sub-phase only adds tool
functions + their registry entries.

**One infra prerequisite** lands before the first V2 tool: extend
`getGoogleAccessTokenForAgentGroup` to return `{ token, principal }`
where `principal` is `'self' | 'instructor-fallback'`. The current
function returns just the token, so callers can't tell whether the
caller's own credentials were used or the instructor's. Every V2 tool
needs that distinction to enforce the mode-2 refusals below — and
even mode-3 callers can use it for clearer error messages ("you
haven't completed /gauth yet"). Implementation: trivial; the function
already branches internally on per-student token presence.

## OAuth scopes

`DEFAULT_GWS_SCOPES` in `src/gws-auth.ts` already covers everything
V2 will touch:

| Scope                                            | Used by V2 sub-phase            |
|--------------------------------------------------|---------------------------------|
| `https://www.googleapis.com/auth/spreadsheets`   | 13.5a (sheets)                  |
| `https://www.googleapis.com/auth/calendar`       | 13.5b (calendar)                |
| `https://www.googleapis.com/auth/drive`          | 13.5c (drive listing — already used by 13.2/13.4) |
| `https://www.googleapis.com/auth/gmail.modify`   | 13.5d (gmail)                   |

No re-consent needed when V2 lands — instructor and per-student tokens
both already carry these scopes. Cuts the rollout cost to "ship code,
nothing else."

## Three deployment modes

V2 is **designed for mode 3** (per-person OAuth). Modes 1 and 2 are
documented degradation paths that the same code path handles, not
parallel implementations.

**Mode 1 — single instructor / non-class install.** One GWS account,
no roles, no Phase 14. Every call resolves the host's single OAuth
bearer; the relay's role matrix collapses to "all" everywhere. This
is what the install does today and what most non-classroom users
will run forever. Mode 3 code in this mode is just "resolve the
sole bearer and call Google" — no extra cost.

**Mode 2 — class install, pre-Phase-14.** Roles exist in the DB
(`student_NN`, `ta_*`, `instructor_*`) but per-student OAuth isn't
wired yet. Every call still resolves the instructor's bearer. The
*only* enforcement of "student → own data" is URL/ID parsing inside
the relay or tool handler. This is brittle by design — the parent
plan calls it a "real boundary problem" — and **mode 2 must not be
exposed to students** for any tool that touches data outside their
own scope. Each V2 sub-phase below states its mode-2 stance (most
will refuse to dispatch for student/ta callers in mode 2).

**Mode 3 — class install, post-Phase-14.** Each student/TA/instructor
has their own refresh token at
`data/student-google-auth/<sanitized_user_id>/credentials.json`.
`getGoogleAccessTokenForAgentGroup` picks the right token based on
the calling agent group's `student_user_id` metadata. Boundaries are
enforced by Google itself: a student token literally can't see the
instructor's Drive. This is the safe-for-classroom mode and the one
the role matrix below assumes.

**Mode detection.** The relay doesn't need an explicit mode flag — it
asks `getGoogleAccessTokenForAgentGroup(agentGroupId)` for a token
and falls back to the instructor token if no per-student token
exists. Mode 2 is the state where the fallback fires for a student
caller. Each V2 tool handler can check `wasFallback` (returned
alongside the token) and refuse to run if the caller's role + the
tool's scope demand mode 3.

## Role matrix (assumes mode 3)

Each tool is gated by `canAccessAgentGroup` (already enforced in
`gws-mcp-relay.ts`). The matrix below specifies what each role can do
*through the relay's resolved OAuth bearer*, **assuming mode 3**. In
mode 1 every cell collapses to "all" (one principal). In mode 2,
student/TA cells must read "refuse" for any tool that's not safe
against the instructor bearer — see per-tool stance below.

| Tool                          | Student     | TA          | Instructor | Non-class agent |
|-------------------------------|-------------|-------------|------------|-----------------|
| `sheet_read_range`            | own files   | class files | all        | all             |
| `sheet_write_range`           | own files   | class files | all        | all             |
| `calendar_create_event`       | own cal     | own + class | all        | all             |
| `calendar_list_events`        | own cal     | own + class | all        | all             |
| `drive_list_files`            | own scope   | class scope | all        | all             |
| `gmail_search`                | own inbox   | own inbox   | all        | all             |
| `gmail_send`                  | **blocked** | **blocked** | own only   | own only        |

`gmail_send` deliberately stays blocked for students/TAs even after
Phase 14, because impersonation risk outweighs the niche utility. Open
explicitly if a real instructor-approved workflow emerges.

## Per-sub-phase plan

### 13.5a — Sheets read + write

**Trigger to start:** a class needs a gradebook, attendance, or
structured-data collection workflow that students or TAs must update
programmatically.

**Mode stance.** Mode 1: works (instructor's own sheets). Mode 2:
**refuse for student/TA callers** — the sole bearer is the
instructor's, so any sheet ID a student supplies would resolve
against the instructor's Drive. Mode 3: full row from the matrix.

- New dep: `@googleapis/sheets` (per-API package; check release age
  policy on the host).
- `src/gws-mcp-tools.ts` — add `sheetReadRange`, `sheetWriteRange`.
  Read returns `{ ok: true, spreadsheetId, range, rows: string[][], cells: number }`.
  Write takes `{ spreadsheet_id, range, values: string[][], value_input_option?: 'RAW'|'USER_ENTERED' }`
  and returns `{ ok: true, spreadsheetId, range, updatedCells: number }`.
- `src/gws-mcp-server.ts` — register both. Validators check `spreadsheet_id` + `range` shape (A1 notation).
- `container/agent-runner/src/mcp-tools/gws.ts` — two new shims using
  the existing `callRelay` helper. Export both for tests.
- `container/agent-runner/src/mcp-tools/gws.test.ts` — extend with 4
  cases (read success, read error, write success, write w/ value_input_option).
- `src/gws-mcp-server.test.ts` — extend `listToolNames` expectation;
  add per-validator unit tests.

### 13.5b — Calendar list + create

**Trigger to start:** office hours, deadlines, or class-schedule
workflows.

**Mode stance.** Mode 1: works on instructor's primary calendar.
Mode 2: read-only for students/TAs against the *instructor's*
calendar (low-risk — student sees instructor's office hours), but
**refuse `calendar_create_event`** for student/TA callers in mode 2
(would create events on instructor's calendar, impersonation risk).
Mode 3: full matrix.

- New dep: `@googleapis/calendar`.
- Tools:
  - `calendar_list_events({ calendar_id?, time_min?, time_max?, q?, max_results? })`
    → `{ ok: true, events: Array<{ id, summary, start, end, attendees? }> }`.
    `calendar_id` defaults to `primary` of the resolved auth principal.
  - `calendar_create_event({ calendar_id?, summary, start, end, attendees?, description?, location? })`
    → `{ ok: true, eventId, htmlLink }`.
- Stamping invites onto students' own calendars (Phase 14 dependent)
  is the main reason these are useful. Pre-14, instructor's calendar
  only — explicitly documented.
- Same dual-layer tests as 13.5a.

### 13.5c — Drive listing

**Trigger to start:** agents need to discover what's in their Drive
scope (rclone view stale or filter-heavy queries don't translate
cleanly to a filesystem walk).

**Mode stance.** Mode 1: lists everything the instructor sees. Mode 2:
**refuse for student/TA callers** — listing the instructor's whole
Drive is the worst possible leak. (The q-mutation to constrain by
class folder is a Google-side filter and trivially bypassable
client-side; can't be the boundary.) Mode 3: q-mutation constrains
to the role's folder and Google enforces the rest.

- No new dep (already on `@googleapis/drive`).
- Tool: `drive_list_files({ q?, page_size?, page_token?, fields? })`
  → `{ ok: true, files: Array<{ id, name, mimeType, modifiedTime, parents? }>, nextPageToken? }`.
- Role scoping in `gws-mcp-tools.ts`: when the resolved principal is a
  student or TA, automatically AND the user-supplied `q` with a parent-
  folder constraint resolved from the classroom roster. (`canAccessAgentGroup`
  already gates the call; this enforces *what the call sees*.)
- Test note: golden test for the q-mutation logic in particular,
  because that's the security boundary.

### 13.5d — Gmail (instructor-only V2)

**Trigger to start:** instructor needs the agent to draft+send emails
on their behalf (e.g., "email the parents of students with overdue
assignments").

**Mode stance.** Same in all three modes: `gmail_send` is blocked for
student/TA callers regardless of mode (impersonation risk outweighs
utility). `gmail_search` is also refused for student/TA in mode 2
(instructor inbox leak); allowed against own inbox in mode 3.

- New dep: `@googleapis/gmail`.
- Tools:
  - `gmail_search({ q, max_results? })` →
    `{ ok: true, messages: Array<{ id, threadId, snippet, from, to, subject, date }> }`.
  - `gmail_send({ to, subject, body, cc?, bcc?, reply_to_message_id? })`
    → `{ ok: true, messageId, threadId }`.
- Relay-level guard: both tools refuse if the resolved role is
  `student` or `ta`. This is a stronger guard than `canAccessAgentGroup`
  because even a non-class scoped admin shouldn't auto-send mail on
  someone else's behalf without a clear approval flow.
- `gmail_send` deliberately has no draft/preview step in V2 — if the
  call goes through, the email goes out. Adding a "draft + approve"
  flow is a Phase 15+ idea, tracked separately when use case appears.

## Open questions (decide at sub-phase start, not now)

- **Pagination defaults.** `drive_list_files` and `gmail_search` are
  the only paginating tools. Default `page_size` of 50 or 100? Stop
  iterating on caller side or include nextPageToken transparently?
- **Time-range parsing for calendar.** Accept ISO-8601 strings only,
  or also natural-language ("today", "next monday") via a tiny
  helper? V1 of every tool prefers strict ISO; helpers can come later.
- **Empty `values` writes for sheets.** Drive treats an empty write as
  a clear. Decide: error out, or pass through? Probably error — agents
  asking for "clear range X" should use a different tool name.
- **Per-tool dry-run flag.** Useful for gmail_send specifically; not
  for the others. Defer.

## Non-goals for V2

- **Bulk operations.** No batch APIs. Agents loop in their own time.
- **Watch / push notifications.** Drive/Gmail push subscriptions are
  out — adds host-side endpoints we don't need yet.
- **Editing Calendar events** (`calendar_update_event` /
  `calendar_delete_event`). Add only with a real cleanup workflow
  driving them.
- **Drive folder creation.** `class-drive.ts` already does this for
  the classroom path; expose as a tool only if a non-classroom
  workflow needs it.

## Acceptance criteria for the whole phase

13.5 isn't "done" — it's a parent phase under which 13.5a / 13.5b /
13.5c / 13.5d each ship independently. The parent is done when each
sub-phase is either landed or explicitly closed-as-not-needed.

Suggested order: 13.5a (sheets) first — gradebook is the most likely
classroom need. Defer 13.5b–d until a concrete request shows up.

## Substeps

#### 13.5.0 — Plan ✅ (this file)

#### 13.5a — Sheets read/write

#### 13.5b — Calendar list/create

#### 13.5c — Drive listing

#### 13.5d — Gmail (instructor-only)
