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

      // If allowedModels whitelist is set, filter the catalog to those entries.
      // If not, show every catalog entry (no restriction).
      const catalog = data.catalog || [];
      const allow = (data.allowedModels && data.allowedModels.length > 0)
        ? new Set(data.allowedModels.map((a) => `${a.provider}/${a.model}`))
        : null;
      const visible = allow ? catalog.filter((m) => allow.has(`${m.provider}/${m.id}`)) : catalog;

      const providers = [...new Set(visible.map((m) => m.provider))];
      provSel.innerHTML = '';
      for (const p of providers) provSel.add(new Option(p, p));

      const renderModels = () => {
        modelSel.innerHTML = '';
        for (const m of visible.filter((mm) => mm.provider === provSel.value)) {
          modelSel.add(new Option(m.displayName || m.id, m.id));
        }
      };
      provSel.addEventListener('change', renderModels);
      renderModels();

      // Provider/model switch handlers wired by Task 6.4.
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

  // ⌘↵ / Ctrl-↵ submits.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
