# Simple Tab Trace Roll-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the student roll up the My-Agent side panel (below the toggle + name) to reveal the live trace window underneath, on the same plane as the chat — by re-parenting the Chat tab's already-wired trace panel, not duplicating it.

**Architecture:** The simple tab's embedded chat already contains a fully live `.trace-panel` (SSE events flow into it); it is merely CSS-hidden. We (1) make chat.js capture its trace element once at wiring time instead of re-querying at event time, (2) wrap the right column in a `.simple-side-stack`, move the trace panel into a `.simple-trace-host` there, and (3) drive everything off a `.trace-open` class on `.simple-mode` (same pattern as `.agent-off`). Spec: `docs/superpowers/specs/2026-06-12-simple-tab-trace-rollup-design.md`.

**Tech Stack:** Vanilla JS (no framework) static-served from `src/channels/playground/public/`; vitest + happy-dom for DOM tests; Playwright MCP for live verification.

---

## Project-specific rules (read first)

- **NEVER run `prettier --write` (or any formatter) on files under `src/channels/playground/public/`** — they are hand-formatted. The pre-commit hook only checks `src/**/*.ts`, which excludes these `.js` files, but do not format them manually either.
- These are static assets: the browser picks up changes on refresh. `pnpm run build` is for hygiene (it compiles host TS), not for deploying these files.
- Run tests with `pnpm exec vitest run src/channels/playground/public/tabs/` for the fast loop and `pnpm test` for the full suite.
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- The pre-commit hook regenerates `state.md`'s volatile section — extra `state.md` churn in your commit diff is expected, not a mistake.

## Background you need

Both tabs mount `chat.js` (`mountChat`), so `#trace-log`, `#chat-log`, etc. exist **twice** document-wide. chat.js only ever queries within its mount root (`el`), so the instances stay independent. **Never use `document.querySelector` for these IDs.**

`mountChat(el)` (chat.js:17) builds the DOM, then calls `wireSse(el, folder)`, `wireChatForm(el, folder)`, `wireTraceClear(el)`. `wireSse` already captures `const trace = el.querySelector('#trace-log')` once at wiring time (chat.js:299) and every SSE event renders through that reference. But two other functions query `#trace-log` **inside event handlers** (i.e., at event time, after the simple tab will have moved the node out of `el`):

- `wireChatForm`'s submit handler: chat.js:483 (direct mode) and chat.js:525 (agent mode)
- `wireTraceClear`'s click handler: chat.js:598

Task 1 fixes those three sites. Task 2 then re-parents the panel safely.

---

### Task 1: chat.js — capture the trace element once at wiring time

This is a mechanical refactor with no behavior change for the Chat tab (same element either way). It is the enabler for re-parenting: after this task, chat.js never looks the trace element up after wiring time. No new test in this task — the existing suite guards the Chat tab, and Task 2's tests + Task 4's live verification cover the new guarantee.

**Files:**
- Modify: `src/channels/playground/public/tabs/chat.js:372-375` (wireChatForm top), `:481-485` and `:525` (submit handler), `:596-603` (wireTraceClear)

- [ ] **Step 1: Capture the trace element at the top of `wireChatForm`**

At chat.js:372-375, the function currently opens:

```js
function wireChatForm(el, folder) {
  const form = el.querySelector('#chat-form');
  const input = el.querySelector('#chat-input');
  const log = el.querySelector('#chat-log');
```

Add the trace capture after `log`:

```js
function wireChatForm(el, folder) {
  const form = el.querySelector('#chat-form');
  const input = el.querySelector('#chat-input');
  const log = el.querySelector('#chat-log');
  // Captured once at wiring time, like wireSse does. The simple tab
  // re-parents the trace panel OUT of this mount root (adoptTracePanel,
  // simple.js), so an event-time el.querySelector would return null.
  const trace = el.querySelector('#trace-log');
```

- [ ] **Step 2: Use the captured reference in the direct-mode branch**

At chat.js:481-485 (inside the submit handler), this block:

```js
      const provSel = el.querySelector('#provider-sel');
      const modelSel = el.querySelector('#model-sel');
      const trace = el.querySelector('#trace-log');
      startNewTurn(trace);
      const traceLi = appendDirectTraceCall(trace, provSel.value, modelSel.value, directHistory.length);
```

becomes (delete the inner `const trace` line — the outer one is now in scope):

```js
      const provSel = el.querySelector('#provider-sel');
      const modelSel = el.querySelector('#model-sel');
      startNewTurn(trace);
      const traceLi = appendDirectTraceCall(trace, provSel.value, modelSel.value, directHistory.length);
```

- [ ] **Step 3: Use the captured reference in the agent-mode branch**

At chat.js:525:

```js
    // Agent mode — start a new turn group in the trace pane.
    startNewTurn(el.querySelector('#trace-log'));
```

becomes:

```js
    // Agent mode — start a new turn group in the trace pane.
    startNewTurn(trace);
```

- [ ] **Step 4: Hoist the query in `wireTraceClear`**

At chat.js:596-603, this function:

```js
function wireTraceClear(el) {
  el.querySelector('#trace-clear-btn').addEventListener('click', () => {
    const trace = el.querySelector('#trace-log');
    trace.innerHTML = '<li class="trace-empty">Trace cleared.</li>';
    trace._currentTurnUl = null;
    trace._piState = null;
  });
}
```

becomes:

```js
function wireTraceClear(el) {
  // Capture-once at wiring time — see the note in wireChatForm.
  const trace = el.querySelector('#trace-log');
  el.querySelector('#trace-clear-btn').addEventListener('click', () => {
    trace.innerHTML = '<li class="trace-empty">Trace cleared.</li>';
    trace._currentTurnUl = null;
    trace._piState = null;
  });
}
```

- [ ] **Step 5: Run the playground tab tests**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/`
Expected: all pass (chat-trace.test.ts 's tests exercise the exported trace renderers; simple.test.ts's 14 tests untouched).

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/chat.js
git commit -m "refactor(playground): capture chat trace element once at wiring time

All trace lookups now happen when mountChat wires handlers, never at
event time — so a parent may re-parent the trace panel outside the
mount root without breaking direct-mode turns or the Clear button.
wireSse already worked this way; this aligns wireChatForm and
wireTraceClear with it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: simple.js — side stack DOM, trace re-parent, roll-up wiring (TDD)

Three small exported helpers (`adoptTracePanel`, `applyTraceRollup`, `wireTraceRollup`) plus markup changes in `mountSimple`. Exported helpers keep the logic testable in happy-dom without needing `mountChat` (which requires fetch/EventSource).

**Files:**
- Modify: `src/channels/playground/public/tabs/simple.js` (markup in `mountSimple` ~lines 86-125; new exports after `applyUseAgentToggle` ~line 81)
- Test: `src/channels/playground/public/tabs/simple.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/channels/playground/public/tabs/simple.test.ts` (and add `adoptTracePanel, wireTraceRollup` to the import list from `./simple.js` at the top of the file):

```ts
describe('trace roll-up', () => {
  function rollupWrapper() {
    const wrapper = document.createElement('div');
    wrapper.className = 'simple-mode';
    wrapper.innerHTML = `
      <div class="simple-chat-host">
        <aside class="trace-panel"><ul id="trace-log"></ul></aside>
      </div>
      <button type="button" class="simple-rollup-btn" aria-expanded="false" title="Show trace">▴</button>
      <div class="simple-trace-strip">🔍 trace — underneath</div>
      <div class="simple-trace-host"></div>
    `;
    return wrapper;
  }

  it('adoptTracePanel moves the SAME trace-panel node into the side host', () => {
    const wrapper = rollupWrapper();
    const panel = wrapper.querySelector('.trace-panel')!;
    const log = wrapper.querySelector('#trace-log')!;
    adoptTracePanel(wrapper);
    // Same node, not a copy — chat.js's captured references must survive.
    expect(wrapper.querySelector('.simple-trace-host .trace-panel')).toBe(panel);
    expect(wrapper.querySelector('.simple-trace-host #trace-log')).toBe(log);
    expect(wrapper.querySelector('.simple-chat-host .trace-panel')).toBeNull();
  });

  it('chevron click toggles .trace-open, aria-expanded, glyph, and title', () => {
    const wrapper = rollupWrapper();
    wireTraceRollup(wrapper);
    const btn = wrapper.querySelector('.simple-rollup-btn') as HTMLButtonElement;

    btn.click();
    expect(wrapper.classList.contains('trace-open')).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.textContent).toBe('▾');
    expect(btn.title).toBe('Hide trace');

    btn.click();
    expect(wrapper.classList.contains('trace-open')).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('▴');
    expect(btn.title).toBe('Show trace');
  });

  it('clicking the peek strip rolls up (opens only, never toggles closed)', () => {
    const wrapper = rollupWrapper();
    wireTraceRollup(wrapper);
    const strip = wrapper.querySelector('.simple-trace-strip') as HTMLElement;
    strip.click();
    expect(wrapper.classList.contains('trace-open')).toBe(true);
    strip.click(); // strip is CSS-collapsed when open, but must not toggle closed either way
    expect(wrapper.classList.contains('trace-open')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: FAIL — `adoptTracePanel` / `wireTraceRollup` are not exported from `./simple.js`.

- [ ] **Step 3: Add the three helpers to simple.js**

Insert after `applyUseAgentToggle` (which ends at simple.js:81), before `mountSimple`:

```js
/**
 * Move the embedded chat's live trace panel into the side stack's
 * .simple-trace-host. chat.js wires ALL trace rendering against element
 * references captured at wiring time (see wireSse/wireChatForm/
 * wireTraceClear), so the moved node — same node, not a copy — keeps
 * receiving SSE events, direct-mode turns, and Clear clicks. Must run
 * after mountChat.
 */
export function adoptTracePanel(wrapper) {
  const host = wrapper.querySelector('.simple-trace-host');
  const panel = wrapper.querySelector('.simple-chat-host .trace-panel');
  if (host && panel) host.appendChild(panel);
}

/**
 * Roll the panel body up (open=true: body + peek strip collapse, the trace
 * underneath expands to the chat's bottom edge) or back down. All visuals
 * are CSS keyed off .trace-open — same pattern as .agent-off.
 */
export function applyTraceRollup(wrapper, open) {
  wrapper.classList.toggle('trace-open', open);
  const btn = wrapper.querySelector('.simple-rollup-btn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? '▾' : '▴';
    btn.title = open ? 'Hide trace' : 'Show trace';
  }
}

/** Chevron toggles; clicking the peek strip only ever opens. */
export function wireTraceRollup(wrapper) {
  const btn = wrapper.querySelector('.simple-rollup-btn');
  const strip = wrapper.querySelector('.simple-trace-strip');
  if (btn) btn.addEventListener('click', () => applyTraceRollup(wrapper, !wrapper.classList.contains('trace-open')));
  if (strip) strip.addEventListener('click', () => applyTraceRollup(wrapper, true));
}
```

- [ ] **Step 4: Update the `mountSimple` markup and mount sequence**

In `mountSimple` (simple.js:86-125), replace the right column. The current markup has `<aside class="simple-panel">…</aside>` as a direct child of `.simple-layout`; wrap it in the side stack, add the chevron to the header, and add the strip + host below the panel:

```js
        <div class="simple-side-stack">
          <aside class="simple-panel">
            <div class="simple-panel-header">
              <label class="simple-toggle" title="Off = talk to the raw model — no skills, no personality">
                <input type="checkbox" id="simple-use-agent" checked>
                <span>Use agent</span>
              </label>
              <input id="simple-agent-name" class="simple-name-input" maxlength="40"
                     title="Your agent's name — click to edit" aria-label="Agent name">
              <button type="button" class="simple-rollup-btn" aria-expanded="false" title="Show trace">▴</button>
            </div>
            <div class="simple-panel-body">
              <div class="simple-section-label">Skills <span class="simple-hint">(click ⓘ to learn)</span></div>
              <div id="simple-skills"></div>
              <div class="simple-section-label">Personality</div>
              <textarea id="simple-persona" rows="6"></textarea>
              <button id="simple-save" class="btn btn-primary" type="button">Save my agent</button>
              <div id="simple-save-status" class="simple-save-status" role="status"></div>
            </div>
          </aside>
          <div class="simple-trace-strip">🔍 trace — underneath</div>
          <div class="simple-trace-host"></div>
        </div>
```

(The `.simple-panel-body` contents are unchanged — only the wrapper, chevron, strip, and host are new.)

Then update the mount sequence at the bottom of `mountSimple` (currently `mountChat(...)` then `initPanel(...)`):

```js
  const wrapper = el.querySelector('.simple-mode');
  mountChat(el.querySelector('.simple-chat-host'));
  adoptTracePanel(wrapper); // after mountChat: handlers wired, references captured
  wireTraceRollup(wrapper);

  initPanel(wrapper, folder);
```

Also update the file-header comment (simple.js:5-6), which currently says scoped CSS hides "toolbar, trace panel" — the trace panel is now re-parented into the side stack, not hidden. Change the parenthetical to `(toolbar)` and add one line noting the trace panel is adopted into the side stack (`adoptTracePanel`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/channels/playground/public/tabs/simple.test.ts`
Expected: PASS — 17 tests (14 existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/tabs/simple.js src/channels/playground/public/tabs/simple.test.ts
git commit -m "feat(playground): side-stack DOM + trace re-parent + roll-up wiring on simple tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: style.css — roll-up CSS

Pure CSS; no test runner coverage (verified live in Task 4). All edits are in the "My Agent" simple-tab section of `src/channels/playground/public/style.css` (starts at the `/* ── "My Agent" simple tab ── */` banner, line 1658).

**Files:**
- Modify: `src/channels/playground/public/style.css:1662-1663` (hide rules), `:1708-1715` (.simple-panel), `:1901-1908` (reduced-motion block), plus new rules after the layering block (ends at 1899)

- [ ] **Step 1: Drop the trace-panel hide rule**

At style.css:1660-1663:

```css
/* Hide the chat tab's advanced chrome — the side panel drives the hidden
   controls programmatically (see tabs/simple.js header comment). */
.simple-mode .chat-toolbar { display: none; }
.simple-mode .trace-panel { display: none; }
```

becomes:

```css
/* Hide the chat tab's advanced chrome — the side panel drives the hidden
   controls programmatically (see tabs/simple.js header comment). The trace
   panel is NOT hidden: it is re-parented into .simple-trace-host
   (adoptTracePanel) and shown/hidden by the roll-up rules below. */
.simple-mode .chat-toolbar { display: none; }
```

- [ ] **Step 2: Move column sizing from `.simple-panel` to the new stack**

At style.css:1708-1715:

```css
.simple-panel {
  flex: 1;
  min-width: 220px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  align-self: flex-start;
}
```

becomes (the side stack owns column sizing now; the panel is content-height inside it):

```css
.simple-side-stack {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  min-height: 0; /* lets .simple-trace-host shrink/scroll within .simple-layout */
}
.simple-panel {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
```

(Removing `align-self: flex-start` is what lets the stack reach `.simple-layout`'s bottom edge — `align-items: stretch` is its default — so the rolled-up trace sits on the same plane as the chat.)

- [ ] **Step 3: Add the roll-up block after the layering block**

Insert after the `.simple-mode.agent-off .simple-panel` rule (ends style.css:1899), before the `@media (prefers-reduced-motion: reduce)` block:

```css
/* ── Trace roll-up: the panel rides above the trace ──
   Mirrors the left column's layering metaphor on the right: the panel is
   the agent's surface; a peek strip teaches that the trace machinery is
   underneath. .trace-open on .simple-mode (applyTraceRollup) collapses the
   panel body + strip and expands .simple-trace-host, which holds the chat
   tab's re-parented .trace-panel (adoptTracePanel — same live node, so the
   existing .trace-* rules apply untouched). Works in both agent ON and OFF
   modes; the strip stays neutral gray (no .agent-off collapse — unlike the
   model strip, the trace exists in both modes). */
.simple-panel-body {
  /* Cap must comfortably exceed the tallest real panel (skills list +
     persona textarea) or the collapse animation jumps. */
  max-height: 600px;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.simple-rollup-btn {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-faint);
  font-size: 13px;
  padding: 0 2px;
}
.simple-trace-strip {
  font-size: 11px;
  color: var(--text-faint);
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 8px 8px;
  margin: 0 10px; /* narrower than the panel — reads as the layer underneath */
  padding: 3px 10px;
  overflow: hidden;
  max-height: 2em;
  cursor: pointer;
  transition: max-height 0.3s ease, padding 0.3s ease, opacity 0.3s ease;
}
.simple-trace-host {
  display: none;
}
.simple-mode.trace-open .simple-panel-body {
  max-height: 0;
}
.simple-mode.trace-open .simple-trace-strip {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
  border-width: 0;
}
.simple-mode.trace-open .simple-trace-host {
  display: flex; /* display swap doesn't animate — the body/strip collapse carries the motion */
  flex-direction: column;
  flex: 1;
  min-height: 0; /* height chain: host → .trace-panel (flex:1) → .trace-log (overflow-y: auto) */
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden; /* clean rounded corners over the square trace panel */
  background: #fafafa; /* matches .trace-panel so the rounded frame reads as one surface */
}
```

- [ ] **Step 4: Extend the reduced-motion guard**

At style.css:1901-1908 (now shifted down), the block:

```css
@media (prefers-reduced-motion: reduce) {
  .simple-agent-card,
  .simple-card-header,
  .simple-model-strip,
  .simple-mode .simple-panel {
    transition: none;
  }
}
```

becomes:

```css
@media (prefers-reduced-motion: reduce) {
  .simple-agent-card,
  .simple-card-header,
  .simple-model-strip,
  .simple-mode .simple-panel,
  .simple-panel-body,
  .simple-trace-strip {
    transition: none;
  }
}
```

- [ ] **Step 5: Quick sanity check in the browser**

The playground serves these files statically. With the host running, open `http://127.0.0.1:3002`, go to the My Agent tab, and confirm: peek strip visible under the panel; chevron rolls the panel body up and the trace pane appears, reaching the same bottom edge as the chat; chevron rolls back down. (Full verification matrix is Task 4 — this is just a smoke check before committing.)

- [ ] **Step 6: Commit**

```bash
git add src/channels/playground/public/style.css
git commit -m "feat(playground): trace roll-up CSS — peek strip, .trace-open collapse, side-stack height chain

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Verification + state.md

No new code — run the full gates and verify the feature live, then record the decision.

**Files:**
- Modify: `state.md` (decision log)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all pass (was 1232 before this work; now 1235 with the 3 new tests). If anything fails, fix before proceeding.

- [ ] **Step 2: Build hygiene**

Run: `pnpm run build`
Expected: clean exit (these are static `.js` assets, but the build must stay green).

- [ ] **Step 3: Live verification (Playwright MCP against http://127.0.0.1:3002, My Agent tab)**

Verify each of these; use `browser_evaluate` with `getComputedStyle` / `getBoundingClientRect` for geometry rather than eyeballing screenshots:

1. **Default state:** peek strip visible under the panel with text `🔍 trace — underneath`; `.simple-trace-host` computed `display: none`; chevron shows `▴`, `aria-expanded="false"`.
2. **Roll up:** click the chevron → `.simple-mode` has `.trace-open`; panel body computed `max-height: 0px`; trace host visible; **same plane check:** trace host's `getBoundingClientRect().bottom` within a few px of the chat card / `.simple-layout` bottom; `#chat-log`'s bottom unchanged.
3. **Live agent trace:** with trace open and Use agent ON, send a message → trace entries appear in the right column (turn group + events), and the reply lands in chat.
4. **Live direct trace:** toggle Use agent OFF (panel sinks; roll-up still present), send a message → a direct-call trace entry appears and finalizes with latency/tokens.
5. **Clear:** click the trace's Clear button → log resets to "Trace cleared." (regression check for the chat.js refactor).
6. **Roll down:** click the chevron → body and strip return, trace host hidden.
7. **Strip click:** from rolled-down, click the strip → opens.
8. **Chat tab unaffected:** switch to the Chat tab, send nothing — its trace panel still sits beside its chat log as before (computed `display: flex`, inside `.chat-layout`).
9. **Internal scroll:** with many trace entries, `.trace-log` scrolls internally (clientHeight < scrollHeight) rather than growing the page.

- [ ] **Step 4: state.md decision-log entry**

Append to the Decision log in `state.md` (follow the existing entry format, dated 2026-06-12): the simple tab's side panel now rolls up (chevron / peek strip, `.trace-open`) to reveal the chat tab's trace panel, re-parented via `adoptTracePanel`; chat.js trace lookups changed to capture-once at wiring time to make re-parenting safe; works in both agent ON/OFF modes.

- [ ] **Step 5: Commit**

```bash
git add state.md
git commit -m "docs(state): trace roll-up decision-log entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
