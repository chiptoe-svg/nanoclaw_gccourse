import { showDraftBanner } from '../draft-banner.js';

let catalogCache = [];
let discoveredCache = [];
let allowedModelsCache = [];
let originalAllowed = [];
let activeModel = null;

export function mountModels(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="models-layout">
      <header class="models-header">
        <h3>Lock in which models your agent can use</h3>
        <p class="hint">💡 Local models cost $0 per token but spend your hardware. Cloud models cost real money but are faster on commodity laptops.</p>
      </header>

      <section class="model-section" data-provider="claude">
        <header class="model-section-header">
          <h4 class="models-section-title">Claude (Anthropic)</h4>
        </header>
        <div class="model-grid" data-grid="claude"></div>
      </section>

      <section class="model-section" data-provider="codex">
        <header class="model-section-header">
          <h4 class="models-section-title">Codex (OpenAI)</h4>
        </header>
        <div class="model-grid" data-grid="codex"></div>
      </section>

      <section class="model-section" data-provider="local">
        <header class="model-section-header">
          <h4 class="models-section-title">Local (your hardware)</h4>
          <span class="model-section-status" id="local-server-status">checking…</span>
        </header>
        <div class="model-grid" data-grid="local"></div>
      </section>
    </div>
  `;

  loadModels(el, folder);
}

function loadModels(el, folder) {
  fetch(`/api/drafts/${folder}/models`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { catalog: [], discovered: [], allowedModels: [], activeModel: null }))
    .then((data) => {
      catalogCache = data.catalog || [];
      discoveredCache = data.discovered || [];
      allowedModelsCache = data.allowedModels || [];
      activeModel = data.activeModel || null;
      originalAllowed = JSON.parse(JSON.stringify(allowedModelsCache));
      renderSections(el);
      pollLocalServer(el);
    });
}

function renderSections(el) {
  for (const provider of ['claude', 'codex', 'local']) {
    const grid = el.querySelector(`[data-grid="${provider}"]`);
    grid.innerHTML = '';

    const curated = catalogCache.filter((m) => m.provider === provider);
    const discovered = discoveredCache.filter((d) => d.provider === provider);

    if (curated.length === 0 && discovered.length === 0) {
      grid.innerHTML = `<div class="muted" style="grid-column: 1 / -1; padding: 12px;">No ${provider} models available. ${
        provider === 'local'
          ? 'Start mlx-omni-server on localhost:8000.'
          : `Add a provider key (${provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}) to .env.`
      }</div>`;
      continue;
    }

    for (const m of curated) {
      grid.appendChild(buildCard(m));
    }
    for (const d of discovered) {
      grid.appendChild(buildDiscoveredCard(d));
    }
  }
}

function isActive(model) {
  return activeModel && activeModel.provider === model.provider && activeModel.model === (model.id || model.model);
}

function buildCard(m) {
  const card = document.createElement('div');
  card.className = `model-card origin-${m.origin || 'cloud'}`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === m.provider && a.model === m.id);
  if (isAllowed) card.classList.add('selected');
  if (isActive({ provider: m.provider, model: m.id })) card.classList.add('active');

  const chipsHtml = (m.chips || []).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('');
  const costLine = m.costPer1kTokensUsd != null ? `$${m.costPer1kTokensUsd} / 1k tokens` : '$0 (local)';
  const latencyLine = m.avgLatencySec != null ? `${m.avgLatencySec}s avg` : '? s';
  const paramsLine = `params: ${escapeHtml(m.paramCount || '?')}`;
  const modalitiesLine = `modalities: ${(m.modalities || ['?']).join(' + ')}`;
  const notes = m.notes ? `<div class="notes">📝 ${escapeHtml(m.notes)}</div>` : '';

  let localExtras = '';
  if (m.origin === 'local') {
    localExtras = `
      <div class="local-extras">
        ${m.host ? `host: <code>${escapeHtml(m.host)}</code><br>` : ''}
        ${m.contextSize ? `context: ${m.contextSize} · ` : ''}${
          m.quantization ? `quantization: ${escapeHtml(m.quantization)}` : ''
        }
      </div>`;
  }

  const activeBadge = isActive({ provider: m.provider, model: m.id })
    ? `<span class="active-badge">● Active</span>`
    : '';
  const useNowBtn =
    isAllowed && !isActive({ provider: m.provider, model: m.id })
      ? `<button class="use-now-btn" type="button">Use now</button>`
      : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(m.displayName || m.id)}</strong>
      ${activeBadge}
    </label>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${costLine} · ${latencyLine}</div>
    <div class="meta-line">${paramsLine} · ${modalitiesLine}</div>
    ${localExtras}
    ${notes}
    ${useNowBtn}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: m.provider, id: m.id }, e.target.checked, card);
  });
  const btn = card.querySelector('.use-now-btn');
  if (btn) {
    btn.addEventListener('click', () => useNow({ provider: m.provider, model: m.id }));
  }
  return card;
}

function buildDiscoveredCard(d) {
  const card = document.createElement('div');
  card.className = `model-card origin-${d.provider === 'local' ? 'local' : 'cloud'} model-card-discovered`;
  const isAllowed = allowedModelsCache.some((a) => a.provider === d.provider && a.model === d.id);
  if (isAllowed) card.classList.add('selected');
  if (isActive({ provider: d.provider, model: d.id })) card.classList.add('active');

  const providerChip =
    d.provider === 'claude' ? '☁ Anthropic' : d.provider === 'codex' ? '☁ OpenAI' : '💻 local';
  const activeBadge = isActive({ provider: d.provider, model: d.id })
    ? `<span class="active-badge">● Active</span>`
    : '';
  const useNowBtn =
    isAllowed && !isActive({ provider: d.provider, model: d.id })
      ? `<button class="use-now-btn" type="button">Use now</button>`
      : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(d.id)}</strong>
      ${activeBadge}
    </label>
    <div class="chips"><span class="chip">${escapeHtml(providerChip)}</span></div>
    <div class="meta-line muted">No curated metadata — bare model id from the provider's /v1/models.</div>
    ${useNowBtn}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: d.provider, id: d.id }, e.target.checked, card);
  });
  const btn = card.querySelector('.use-now-btn');
  if (btn) {
    btn.addEventListener('click', () => useNow({ provider: d.provider, model: d.id }));
  }
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
    // Re-render so Use-now buttons appear/disappear based on whitelist state.
    const el = document.querySelector('.models-layout').parentElement;
    renderSections(el);
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

async function useNow({ provider, model }) {
  const folder = window.__pg.agent.folder;
  try {
    const r = await fetch(`/api/drafts/${folder}/active-model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ provider, model }),
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    activeModel = { provider, model };
    // Re-render so badges + Use-now buttons reposition.
    const el = document.querySelector('.models-layout').parentElement;
    renderSections(el);
    showDraftBanner(`Active model: ${model} (${provider}).`);
  } catch (err) {
    console.error('useNow failed', err);
  }
}

async function pollLocalServer(el) {
  const statusEl = el.querySelector('#local-server-status');
  if (!statusEl) return;
  try {
    // mlx-omni-server's /v1/models is the cheapest reachability check.
    // no-cors mode means a resolved fetch tells us only "host responded",
    // which is exactly what we need for online/offline rendering.
    await fetch('http://localhost:8000/v1/models', { method: 'GET', mode: 'no-cors' });
    statusEl.textContent = '● online';
    statusEl.className = 'model-section-status status-online';
  } catch {
    statusEl.textContent = '○ offline — start mlx-omni-server on :8000';
    statusEl.className = 'model-section-status status-offline';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
