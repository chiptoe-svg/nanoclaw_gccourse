import { showDraftBanner } from '../draft-banner.js';

let sse = null; // single EventSource per agent

export function mountChat(el) {
  const folder = window.__pg.agent.folder;
  const agentName = window.__pg.agent.name;

  el.innerHTML = `
    <div class="chat-toolbar">
      <span>Chat with: <strong>${escapeHtml(agentName)}</strong></span>
      <span class="spacer"></span>
      <label>provider <select id="provider-sel"></select></label>
      <label>model <select id="model-sel"></select></label>
    </div>
    <div class="chat-layout">
      <div class="chat-column">
        <ul id="chat-log" class="chat-log"></ul>
        <form id="chat-form">
          <textarea id="chat-input" rows="1" placeholder="ask your agent…" autocomplete="off"></textarea>
          <button type="submit" class="btn btn-primary">Send</button>
          <span class="send-hint"><kbd>⌘↵</kbd> to send</span>
        </form>
      </div>
      <aside class="trace-panel">
        <header class="trace-header">
          <span class="label">Trace</span>
          <button id="trace-clear-btn" class="btn btn-ghost" type="button">Clear</button>
        </header>
        <ul id="trace-log" class="trace-log">
          <li class="trace-empty">Tool calls, system events, and non-chat agent output will appear here as the agent works.</li>
        </ul>
      </aside>
    </div>
  `;

  loadModelDropdowns(el, folder);
  wireSse(el, folder);
  wireChatForm(el, folder);
  wireTraceClear(el);
}

function loadModelDropdowns(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { catalog: [], allowedModels: [] }))
    .then((data) => {
      const provSel = el.querySelector('#provider-sel');
      const modelSel = el.querySelector('#model-sel');

      // Merge curated catalog entries with live-discovered entries
      // (provider /v1/models that aren't in BUILTIN_ENTRIES — e.g. extra
      // mlx-omni-server models like Qwen3.6-27B or gemma-4-31B). Without
      // this merge, a whitelisted discovered model would silently fail
      // to appear in the dropdown — the user checked it in the Models tab
      // but couldn't actually select it for chat.
      const catalog = data.catalog || [];
      const discovered = (data.discovered || []).map((d) => ({ provider: d.provider, id: d.id }));
      const combined = [...catalog, ...discovered];
      const allow = (data.allowedModels && data.allowedModels.length > 0)
        ? new Set(data.allowedModels.map((a) => `${a.provider}/${a.model}`))
        : null;
      const visible = allow ? combined.filter((m) => allow.has(`${m.provider}/${m.id}`)) : combined;

      const providers = [...new Set(visible.map((m) => m.provider))];
      provSel.innerHTML = '';
      for (const p of providers) provSel.add(new Option(p, p));

      // Pre-select the currently active provider+model returned by the API,
      // falling back to the first catalog entries when none is set. Without
      // this the dropdowns default to whatever happens to be first alphabetically
      // (`claude` / `claude-haiku-4-5`), misrepresenting agents currently
      // configured for a different provider — confusing AND a footgun, since
      // clicking elsewhere then `Apply` would silently rewrite the active model.
      const active = data.activeModel;
      if (active && providers.includes(active.provider)) {
        provSel.value = active.provider;
      }

      const renderModels = () => {
        modelSel.innerHTML = '';
        for (const m of visible.filter((mm) => mm.provider === provSel.value)) {
          modelSel.add(new Option(m.displayName || m.id, m.id));
        }
        if (active && active.provider === provSel.value) {
          // Use Array.from to test for membership without triggering a change event.
          const ids = Array.from(modelSel.options).map((o) => o.value);
          if (ids.includes(active.model)) modelSel.value = active.model;
        }
      };
      // Track last-confirmed provider so a cancelled switch can revert the select.
      let lastProvider = provSel.value;
      provSel.addEventListener('change', async () => {
        const newProvider = provSel.value;
        if (newProvider === lastProvider) {
          renderModels();
          return;
        }
        const ok = await showProviderSwitchModal(lastProvider, newProvider);
        if (!ok) {
          provSel.value = lastProvider;
          return;
        }
        try {
          const r = await fetch(`/api/drafts/${folder}/provider`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ provider: newProvider }),
          });
          if (!r.ok) throw new Error(`status ${r.status}`);
          lastProvider = newProvider;
          renderModels();
          // Fresh container = fresh conversation. Clear the chat log.
          const log = el.querySelector('#chat-log');
          if (log) log.innerHTML = '';
          appendSystemNote(log, `— provider switched to ${newProvider}; container respawning —`);
        } catch (err) {
          appendSystemNote(el.querySelector('#chat-log'), `Provider switch failed: ${String(err)}`);
          provSel.value = lastProvider;
        }
      });
      renderModels();

      modelSel.addEventListener('change', () => {
        const log = el.querySelector('#chat-log');
        appendChatNote(log, `— model changed to ${modelSel.value}; next reply will use it —`);
        // Pulse the dropdown briefly to signal the change.
        modelSel.classList.add('model-changed');
        setTimeout(() => modelSel.classList.remove('model-changed'), 1500);
      });
    })
    .catch(() => {
      // Silently swallow — chat still functions without the dropdowns.
    });
}

function wireSse(el, folder) {
  if (sse) {
    try { sse.close(); } catch { /* ignore */ }
  }
  sse = new EventSource(`/api/drafts/${folder}/stream`);
  const log = el.querySelector('#chat-log');
  const trace = el.querySelector('#trace-log');
  // Clear trace empty-state on first event of any kind.
  let traceEmpty = trace.querySelector('.trace-empty');

  sse.addEventListener('message', (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    if (data.kind === 'trace') {
      if (traceEmpty) { traceEmpty.remove(); traceEmpty = null; }
      appendTraceEvent(trace, data.content || data);
    } else {
      // Chat-kind agent reply
      appendAgentReply(log, data);
    }
  });
  sse.addEventListener('error', () => {
    // Auto-reconnect by browser default; no action needed.
  });
}

function wireChatForm(el, folder) {
  const form = el.querySelector('#chat-form');
  const input = el.querySelector('#chat-input');
  const log = el.querySelector('#chat-log');

  // ↵ submits, Shift+↵ inserts a newline. Matches the convention in
  // Telegram, Slack, iMessage. ⌘↵ / Ctrl-↵ also still submits for muscle
  // memory from the previous behavior.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    appendUserBubble(log, text);
    input.value = '';
    try {
      await fetch(`/api/drafts/${folder}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text }),
      });
    } catch {
      appendSystemNote(log, 'Send failed — check connection.');
    }
  });
}

function wireTraceClear(el) {
  el.querySelector('#trace-clear-btn').addEventListener('click', () => {
    const trace = el.querySelector('#trace-log');
    trace.innerHTML = '<li class="trace-empty">Trace cleared.</li>';
  });
}

function appendUserBubble(log, text) {
  const li = document.createElement('li');
  li.className = 'msg user';
  li.textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function appendAgentReply(log, data) {
  const li = document.createElement('li');
  li.className = 'msg agent';
  // Content may be a string or an object — handle both.
  let text;
  if (typeof data.content === 'string') text = data.content;
  else if (data.content && typeof data.content === 'object' && typeof data.content.text === 'string') text = data.content.text;
  else text = JSON.stringify(data.content);
  li.textContent = text;

  // Cost/speed annotation when fields are present.
  const parts = [];
  if (data.provider && data.model) parts.push(`${data.provider}/${data.model}`);
  if (data.tokens && typeof data.tokens.input === 'number' && typeof data.tokens.output === 'number') {
    parts.push(`${data.tokens.input + data.tokens.output} tok`);
  }
  if (typeof data.latencyMs === 'number') parts.push(`${(data.latencyMs / 1000).toFixed(1)}s`);
  if (parts.length > 0) {
    const annot = document.createElement('div');
    annot.className = 'cost-annot';
    annot.textContent = parts.join(' · ');
    li.appendChild(annot);
  }
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function appendTraceEvent(trace, data) {
  const li = document.createElement('li');
  const kind = data.kind || data.eventType || 'event';
  li.className = `trace trace-${kind}`;

  // Recognize tool envelopes emitted by the agent-runner (mirrors v2 logTrace).
  let summary = '';
  if (data.type === 'tool_use') {
    summary = `tool · ${data.toolName || data.tool || 'unknown'}`;
  } else if (data.type === 'tool_result') {
    summary = data.isError ? 'tool result · error' : 'tool result';
  } else if (kind === 'tool_use') {
    summary = `tool_call · ${data.toolName || data.tool || ''}`;
  } else if (kind === 'tool_result') {
    summary = `tool_result · ${data.isError ? 'error' : 'ok'}`;
  } else {
    summary = data.summary || data.message || kind;
  }

  const kindEl = document.createElement('div');
  kindEl.className = 'trace-kind';
  kindEl.textContent = summary;
  li.appendChild(kindEl);

  // Show a truncated body when there's structured payload.
  const payload = data.input || data.content;
  if (payload != null) {
    const bodyEl = document.createElement('div');
    bodyEl.className = 'trace-body';
    bodyEl.textContent = formatTracePayload(payload);
    li.appendChild(bodyEl);
  }

  trace.appendChild(li);
  trace.scrollTop = trace.scrollHeight;
}

function formatTracePayload(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return truncate(payload, 400);
  if (Array.isArray(payload) && payload.every((b) => b && typeof b === 'object' && 'text' in b)) {
    return truncate(payload.map((b) => b.text).join('\n'), 400);
  }
  try { return truncate(JSON.stringify(payload, null, 2), 600); } catch { return String(payload); }
}

function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

function appendSystemNote(log, text) {
  const li = document.createElement('li');
  li.className = 'msg system';
  li.textContent = text;
  log.appendChild(li);
}

function showProviderSwitchModal(from, to) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h3>⚠ Switch provider?</h3>
          <p>Switching from <strong>${escapeHtml(from)}</strong> to <strong>${escapeHtml(to)}</strong> will <strong>reset this chat</strong> — the running container will be killed and the agent will start a fresh conversation.</p>
          <p class="hint">Your persona, skills, and library entries are not affected. Only the live conversation state is lost.</p>
          <div class="modal-actions">
            <button class="btn" id="modal-cancel">Cancel</button>
            <button class="btn btn-danger" id="modal-ok">Switch &amp; reset chat</button>
          </div>
        </div>
      </div>
    `;
    const cleanup = (result) => { root.innerHTML = ''; resolve(result); };
    root.querySelector('#modal-cancel').addEventListener('click', () => cleanup(false));
    root.querySelector('#modal-ok').addEventListener('click', () => cleanup(true));
  });
}

function appendChatNote(log, text) {
  const li = document.createElement('li');
  li.className = 'chat-note';
  li.textContent = text;
  log.appendChild(li);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
