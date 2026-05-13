import { showDraftBanner } from '../draft-banner.js';

let catalogCache = [];
let allowedModelsCache = [];
let originalAllowed = [];

export function mountModels(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="models-layout">
      <header class="models-header">
        <h3>Lock in which models your agent can use</h3>
        <p class="hint">💡 Local models cost $0 per token but spend your hardware. Cloud models cost real money but are faster on commodity laptops.</p>
      </header>
      <div id="model-grid" class="model-grid"></div>
    </div>
  `;

  loadModels(el, folder);
}

function loadModels(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { catalog: [], allowedModels: [] }))
    .then((data) => {
      catalogCache = data.catalog || [];
      allowedModelsCache = data.allowedModels || [];
      originalAllowed = JSON.parse(JSON.stringify(allowedModelsCache));
      renderGrid(el);
    });
}

function renderGrid(el) {
  const grid = el.querySelector('#model-grid');
  grid.innerHTML = '';
  for (const m of catalogCache) {
    const card = buildCard(m);
    grid.appendChild(card);
    if (m.origin === 'local' && m.host) {
      pollLocalStatus(card.querySelector('.status'), m.host);
    }
  }
}

function buildCard(m) {
  const card = document.createElement('div');
  card.className = `model-card origin-${m.origin || 'cloud'}`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === m.provider && a.model === m.id);
  if (isAllowed) card.classList.add('selected');

  const chipsHtml = (m.chips || []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
  const costLine = m.costPer1kTokensUsd != null
    ? `$${m.costPer1kTokensUsd} / 1k tokens`
    : '$0 (local)';
  const latencyLine = m.avgLatencySec != null ? `${m.avgLatencySec}s avg` : '? s';
  const paramsLine = `params: ${escapeHtml(m.paramCount || '?')}`;
  const modalitiesLine = `modalities: ${(m.modalities || ['?']).join(' + ')}`;

  let localExtras = '';
  if (m.origin === 'local') {
    localExtras = `
      <div class="local-extras">
        ${m.host ? `host: <code>${escapeHtml(m.host)}</code><br>` : ''}
        ${m.contextSize ? `context: ${m.contextSize} · ` : ''}${m.quantization ? `quantization: ${escapeHtml(m.quantization)}` : ''}<br>
        status: <span class="status status-unknown">? checking…</span>
      </div>`;
  }

  const notes = m.notes ? `<div class="notes">📝 ${escapeHtml(m.notes)}</div>` : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(m.displayName || m.id)}</strong>
    </label>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${costLine} · ${latencyLine}</div>
    <div class="meta-line">${paramsLine} · ${modalitiesLine}</div>
    ${localExtras}
    ${notes}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel(m, e.target.checked, card);
  });

  return card;
}

async function toggleModel(model, checked, card) {
  // Update local cache.
  allowedModelsCache = allowedModelsCache.filter(
    (a) => !(a.provider === model.provider && a.model === model.id),
  );
  if (checked) {
    allowedModelsCache.push({ provider: model.provider, model: model.id });
    card.classList.add('selected');
  } else {
    card.classList.remove('selected');
  }

  // PUT to backend.
  const folder = window.__pg.agent.folder;
  try {
    const r = await fetch(`/api/drafts/${folder}/models`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ allowedModels: allowedModelsCache }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    if (JSON.stringify(allowedModelsCache) !== JSON.stringify(originalAllowed)) {
      showDraftBanner('Model whitelist changed.');
    }
  } catch {
    // Revert visual state on failure.
    if (checked) {
      allowedModelsCache = allowedModelsCache.filter(
        (a) => !(a.provider === model.provider && a.model === model.id),
      );
      card.classList.remove('selected');
      card.querySelector('input[type="checkbox"]').checked = false;
    }
  }
}

async function pollLocalStatus(statusEl, host) {
  try {
    // Some local servers (Ollama, mlx-omni) implement /v1/models. CORS may block
    // the actual response — we just need to know if the host is reachable.
    const r = await fetch(`${host.replace(/\/+$/, '')}/v1/models`, {
      method: 'GET',
      mode: 'no-cors',
    });
    // With mode: 'no-cors', successful fetches return opaque responses (r.ok = false).
    // The only way fetch resolves is if the request reached the server. So presence
    // of a resolved promise = "online".
    statusEl.textContent = '● online';
    statusEl.className = 'status status-online';
  } catch {
    statusEl.textContent = '○ offline';
    statusEl.className = 'status status-offline';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
