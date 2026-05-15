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
    .then((r) =>
      r.ok
        ? r.json()
        : { catalog: [], discovered: [], allowedModels: [], activeModel: null, localServerOnline: null },
    )
    .then((data) => {
      catalogCache = data.catalog || [];
      discoveredCache = data.discovered || [];
      allowedModelsCache = data.allowedModels || [];
      activeModel = data.activeModel || null;
      originalAllowed = JSON.parse(JSON.stringify(allowedModelsCache));
      renderSections(el);
      renderLocalServerStatus(el, data.localServerOnline);
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
  const defaultBadge = m.default ? `<span class="default-badge" title="Recommended default for this provider">★ Default</span>` : '';

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(m.displayName || m.id)}</strong>
      ${activeBadge}
      ${defaultBadge}
    </label>
    <div class="chips">${chipsHtml}</div>
    <div class="cost-line">${costLine} · ${latencyLine}</div>
    <div class="meta-line">${paramsLine} · ${modalitiesLine}</div>
    ${localExtras}
    ${notes}
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: m.provider, id: m.id }, e.target.checked, card);
  });
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

  card.innerHTML = `
    <label class="model-head">
      <input type="checkbox" ${isAllowed ? 'checked' : ''}>
      <strong>${escapeHtml(d.id)}</strong>
      ${activeBadge}
    </label>
    <div class="chips"><span class="chip">${escapeHtml(providerChip)}</span></div>
    <div class="meta-line muted">No curated metadata — bare model id from the provider's /v1/models.</div>
    <button class="add-metadata-btn" type="button">＋ Add metadata</button>
  `;

  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleModel({ provider: d.provider, id: d.id }, e.target.checked, card);
  });
  card.querySelector('.add-metadata-btn').addEventListener('click', () => openAddMetadataModal(d));
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
    // Re-render so selection styling stays in sync.
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

function renderLocalServerStatus(el, online) {
  const statusEl = el.querySelector('#local-server-status');
  if (!statusEl) return;
  // Server-side probe result. Browser-side fetches would see a different
  // "localhost" when the user accesses the playground from a different
  // machine (e.g. their phone over the LAN) and incorrectly report offline.
  if (online === true) {
    statusEl.textContent = '● online';
    statusEl.className = 'model-section-status status-online';
  } else if (online === false) {
    statusEl.textContent = '○ offline — start mlx-omni-server on :8000';
    statusEl.className = 'model-section-status status-offline';
  } else {
    statusEl.textContent = '';
    statusEl.className = 'model-section-status';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "Add metadata" modal — pops up when the user clicks ＋ Add metadata on a
// discovered card. Asks for the fields a curated catalog entry needs
// (displayName, params, modalities, context, notes, etc.) and posts to
// PUT /api/catalog/local-entries which appends/replaces in
// config/model-catalog-local.json. Owner-only on the backend.
function openAddMetadataModal(discovered) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Add metadata for <code>${escapeHtml(discovered.id)}</code></h3>
      <p class="muted">
        Promotes this discovered model into a curated catalog entry.
        Saved to <code>config/model-catalog-local.json</code>.
        Only fill in what you know — required fields are marked.
      </p>
      <form id="add-metadata-form" class="add-metadata-form">
        <label>Display name <span class="required">*</span><br>
          <input name="displayName" required value="${escapeHtml(discovered.id)}" type="text"></label>
        <label>Parameter count<br>
          <input name="paramCount" type="text" placeholder="e.g. 27B"></label>
        <fieldset>
          <legend>Modalities</legend>
          <label><input type="checkbox" name="modalities" value="text" checked> text</label>
          <label><input type="checkbox" name="modalities" value="image"> image</label>
          <label><input type="checkbox" name="modalities" value="audio"> audio</label>
        </fieldset>
        <label>Context size (tokens)<br>
          <input name="contextSize" type="number" placeholder="e.g. 32768"></label>
        <label>Quantization<br>
          <input name="quantization" type="text" placeholder="e.g. MLX 4-bit"></label>
        <label>Average latency (seconds)<br>
          <input name="avgLatencySec" type="number" step="0.1" placeholder="e.g. 6"></label>
        <label>Notes<br>
          <textarea name="notes" rows="3" placeholder="Short user-facing description."></textarea></label>
        <label>Best for<br>
          <input name="bestFor" type="text" placeholder="When should someone pick this?"></label>
        <div class="modal-actions">
          <button type="button" class="btn cancel-btn">Cancel</button>
          <button type="submit" class="btn primary">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.querySelector('#add-metadata-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const modalities = fd.getAll('modalities');
    const entry = {
      id: discovered.id,
      provider: discovered.provider,
      displayName: String(fd.get('displayName') || discovered.id),
      origin: discovered.provider === 'local' ? 'local' : 'cloud',
    };
    const paramCount = String(fd.get('paramCount') || '').trim();
    if (paramCount) entry.paramCount = paramCount;
    if (modalities.length > 0) entry.modalities = modalities.map(String);
    const contextSize = Number(fd.get('contextSize'));
    if (contextSize > 0) entry.contextSize = contextSize;
    const quantization = String(fd.get('quantization') || '').trim();
    if (quantization) entry.quantization = quantization;
    const avgLatencySec = Number(fd.get('avgLatencySec'));
    if (avgLatencySec > 0) entry.avgLatencySec = avgLatencySec;
    const notes = String(fd.get('notes') || '').trim();
    if (notes) entry.notes = notes;
    const bestFor = String(fd.get('bestFor') || '').trim();
    if (bestFor) entry.bestFor = bestFor;
    // Local-only nicety: stamp host from the omlx convention so the card's
    // local-extras block populates the same way builtin entries do.
    if (discovered.provider === 'local') entry.host = 'http://localhost:8000';

    try {
      const r = await fetch('/api/catalog/local-entries', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ entry }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(`Save failed: ${err.error || r.status}`);
        return;
      }
      close();
      // Reload models so the freshly-curated card replaces the discovered one.
      const el = document.querySelector('.models-layout').parentElement;
      const folder = window.__pg.agent.folder;
      loadModels(el, folder);
    } catch (err) {
      alert(`Save failed: ${String(err)}`);
    }
  });
}
