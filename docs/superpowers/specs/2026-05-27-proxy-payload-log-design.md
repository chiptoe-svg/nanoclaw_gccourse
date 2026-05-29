# Proxy payload log — design

> Foundation arc for the Chat trace/context panel (replaces the standalone Harness tab from earlier brainstorming). Sibling spec for the panel UI follows.

## Goal

Persist every LLM request body that flows through `src/credential-proxy.ts` to a per-session SQLite store and expose it via a small host endpoint. Same store serves two consumers: the upcoming Chat trace/context panel (primary) and B5-style forensic debugging (secondary, partial — limited by the rolling retention window).

## Why this design

Every LLM call from every container goes through the credential-proxy at port 3001 — Anthropic, OpenAI subscription, OpenAI API, OMLX, Clemson. The proxy already buffers `body = Buffer.concat(chunks)` (`src/credential-proxy.ts:382`) but doesn't persist it. Adding capture there gets us:

- Provider-uniform with no per-provider work
- Byte-exact (the literal bytes that went up the wire)
- Zero container changes
- Re-uses existing per-call attribution (`AGENT_GROUP_HEADER`)

Container-side capture would require touching pi-ai's provider abstraction for each upstream, plus session-DB schema changes on the container's two-writer surface. The proxy approach avoids both.

## Architecture

```
container ──HTTP + headers──▶ credential-proxy ──▶ upstream API
                                    │                   │
                                    ▼                   │
                          per-session payload store    │
                              (SQLite, sole writer)    │
                                    ▲                   │
                                    └── patch status ◀──┘

playground UI ──GET /api/sessions/:id/payloads──▶ host endpoint
                                                      │
                                                      ▼
                                              payload store (read)
```

The proxy is the sole writer to each per-session payload file. The host endpoint is a read-only consumer.

## Components

Four units, each independently testable:

| File | Responsibility |
|---|---|
| `src/proxy-payload-log/store.ts` | Open / write / read / patch on a per-session SQLite file. Owns schema migration on first open. Pure storage layer; no proxy or HTTP knowledge. |
| `src/proxy-payload-log/sections.ts` | Parse a captured request body into per-section sizes. Anthropic schema (`system` / `tools` / `messages[]` with content array per message). OpenAI schema (`messages[]` with content / `tools` / `instructions`). Returns a typed `Sections` shape. Pure function; no IO. |
| `src/credential-proxy.ts` (extend) | Two added calls. After `body = Buffer.concat(chunks)` is built: `const seq = await store.write({route, path, body})` — proxy awaits this (sub-ms; needed to obtain `seq`). In the upstream `'end'` handler: `store.patch(seq, {response_status}).catch(logErr)` — fire-and-forget so the proxy never blocks returning to the container on persistence. Both wrapped so persistence failure never breaks request forwarding. |
| `src/channels/playground/api/payloads.ts` | `GET /api/sessions/:sessionId/payloads?limit=N&after=seq`. Same auth gate as existing sessions endpoints (`canAccessAgentGroup`). Reads from the per-session store, parses sections on demand (caches `sections_json` back into the row on first parse). |

## Data flow

1. Container assembles its LLM request and POSTs it to the credential-proxy with `AGENT_GROUP_HEADER` + new `X-NanoClaw-Session-Id` header.
2. Proxy buffers `body`, resolves the route (anthropic / openai / openai-platform / omlx / clemson), and BEFORE firing the upstream request: calls `store.write({route, path, body, agent_group, session_id, ts})`. Returns a row `seq`.
3. Proxy forwards the request upstream.
4. Upstream responds. Proxy returns to the container immediately AND dispatches `store.patch(seq, {response_status})` as a background promise (errors logged, never blocks the return).
5. Sometime later, a playground client requests `GET /api/sessions/<id>/payloads?after=<seq>`. Handler queries the store, parses any rows whose `sections_json` is NULL (caches result back), returns shaped JSON.

## Headers and attribution

| Header | Source | Set by | Used by proxy for |
|---|---|---|---|
| `AGENT_GROUP_HEADER` (existing) | container env | `container-runner.ts` | per-student credential resolution, payload-store agent-group attribution |
| `X-NanoClaw-Session-Id` (NEW) | container env | `container-runner.ts` adds at spawn | payload-store session-id attribution |

`container-runner.ts:buildContainerArgs` already injects `AGENT_GROUP_ID`; add `NANOCLAW_SESSION_ID` alongside it. The container's HTTP client (pi-ai's transport layer) propagates both as request headers.

If `X-NanoClaw-Session-Id` is missing, the store still writes — `session_id` falls back to the agent-group default with a logged warning (one warning per agent-group pair so it doesn't spam).

## Storage layout

Per-session SQLite file at:

```
data/proxy-payloads/<agent-group>/<session-id>.db
```

Mirrors the existing `data/v2-sessions/<agent-group>/<session-id>/` pattern (where `inbound.db` and `outbound.db` already live). Sole writer is the credential-proxy process — no cross-mount lock contention. Standard `journal_mode = WAL` for fast writes; same pragma as the existing session DBs.

### Schema

```sql
CREATE TABLE payloads (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,           -- ms since epoch
  upstream_route  TEXT NOT NULL,              -- 'anthropic' | 'openai' | 'openai-platform' | 'omlx' | 'clemson'
  upstream_path   TEXT NOT NULL,              -- e.g. '/v1/messages'
  request_body    BLOB NOT NULL,              -- raw bytes; usually JSON, possibly truncated
  request_bytes   INTEGER NOT NULL,           -- length of original body (pre-truncation if any)
  truncated       INTEGER NOT NULL DEFAULT 0, -- 0 | 1, set if request_body was capped
  response_status INTEGER,                    -- filled by store.patch after upstream responds; NULL while in-flight
  sections_json   TEXT                        -- lazy-parsed per-section sizes; NULL until first read
);

CREATE INDEX idx_payloads_ts ON payloads(ts);
```

Migrations: schema lives entirely in `store.ts`'s `init()`; idempotent CREATE TABLE IF NOT EXISTS on first open. No central migrations system involved (per-session DB; same pattern as inbound/outbound).

## Retention

Rolling window of **50 most recent rows per session**. After each successful write, the store runs:

```sql
DELETE FROM payloads WHERE seq <= (SELECT MAX(seq) - 50 FROM payloads);
```

Trade-off acknowledged: B5's secondary forensic value loses fidelity past turn 50 of a long thread. The pedagogical use case (Chat trace panel — never renders 50+ turns at once anyway) is unaffected.

## Configurability

**v1: default-on, no toggle.** Capture runs for every install with no UI control. Storage cost is small (50-row cap × small per-row size × few sessions). The instructor-Home toggle ("enable payload capture / show last N captured") is in scope for Arc B (Home tab revamp) and will be added there.

No env-var opt-out in v1. If an install needs capture disabled before Arc B ships, the operator deletes the `data/proxy-payloads/` directory and the proxy re-creates it on next start — the absence of a per-session file just means an empty trace/context view, not a crash.

## Error handling

| Failure | Behavior |
|---|---|
| `store.write` rejects | `console.error('proxy-payload-log: write failed', err)`. Proxy continues with `seq=null`; upstream request forwarded normally. The row simply doesn't exist; trace panel shows nothing for that call (acceptable). |
| `store.patch` rejects | Logged via the `.catch(logErr)` attached at dispatch. Row stays with `response_status=NULL` (handler treats as "in-flight or unknown"). |
| Session-id header missing | Write with `session_id` = the agent-group's most recent session (looked up via DB). One warning per agent-group per process lifetime. |
| Body exceeds 10 MB | Truncate to 10 MB, set `truncated=1`. UI surfaces this as "(truncated at 10 MB)" in the section view. Hard cap protects disk. |
| Endpoint hit with bad session id | 404. |
| Endpoint hit without auth | 401, same gate as existing session-scoped endpoints. |

## Testing

- **`store.ts` unit tests** (vitest + `better-sqlite3`): open / write / read / patch / retention prune / 10MB cap / concurrent writes within one process.
- **`sections.ts` unit tests:** golden-file fixtures for each supported provider's request schema. Each fixture asserts the parsed `Sections` shape (system bytes, tools bytes, per-message role + content bytes).
- **Proxy integration test** (extends existing `credential-proxy.test.ts`): fake upstream + temp store. Verifies (a) request triggers a write before forward, (b) `'end'` handler patches the status, (c) when `store.write` throws, the upstream request still completes successfully (failure injection).
- **API endpoint test:** seed a temp store, hit `GET /api/sessions/:id/payloads`, assert shape + query-param filtering. Negative tests for auth + missing session.

## Open follow-ups (not in this spec)

1. **Sibling spec — Chat trace/context panel.** Reads from this endpoint. Lives in a separate design doc to be written next.
2. **Arc B integration point.** Home tab revamp will add an instructor-facing toggle that writes a setting consumed by `store.write` (early-return if disabled). The setting key will be `payload_capture_enabled` in the existing agent-group config or central settings table — exact location decided when Arc B is specced.
3. **Long-thread forensic mode (B5 v2).** If post-mortem on threads > 50 turns becomes a recurring need, add a per-agent-group "forensic" mode that bypasses the 50-row prune. Not in scope until somebody asks for it.
