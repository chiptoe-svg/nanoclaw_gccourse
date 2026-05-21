/**
 * Retrieval tab — RAG corpus query interface.
 *
 * Lets the user pick a ready corpus, enter a query, and see ranked BM25 results.
 */

export function mountRetrieval(el) {
  const { folder, token } = window.__pg.agent;

  el.innerHTML = `
    <div class="tab-section" style="padding:16px;max-width:860px">
      <h2 style="margin:0 0 1rem">Retrieval</h2>

      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:14px">
          Corpus
          <select id="ret-corpus-select" style="padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit;min-width:180px">
            <option value="">— loading —</option>
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;font-size:14px">
          Top-k
          <select id="ret-k-select" style="padding:5px 8px;border:1px solid #ccc;border-radius:4px;font:inherit">
            <option value="3">3</option>
            <option value="5" selected>5</option>
            <option value="10">10</option>
          </select>
        </label>
      </div>

      <div style="display:flex;gap:0.5rem;margin-bottom:1.25rem">
        <input id="ret-query-input" type="text" placeholder="Enter a search query&hellip;"
          style="flex:1;padding:7px 10px;border:1px solid #ccc;border-radius:4px;font:inherit;font-size:14px">
        <button id="ret-search-btn" class="btn btn-primary">Search</button>
      </div>

      <div id="ret-results"></div>
    </div>
  `;

  document.title = `Retrieval — ${window.__pg.agent.name} · Agent Playground`;

  const apiBase = `/api/drafts/${folder}/knowledge/corpora`;
  const headers = { 'x-playground-token': token, 'Content-Type': 'application/json' };

  const corpusSelect = el.querySelector('#ret-corpus-select');
  const kSelect = el.querySelector('#ret-k-select');
  const queryInput = el.querySelector('#ret-query-input');
  const searchBtn = el.querySelector('#ret-search-btn');
  const resultsEl = el.querySelector('#ret-results');

  async function loadCorpora() {
    try {
      const res = await fetch(apiBase, { headers, credentials: 'same-origin' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      const ready = (data.corpora ?? []).filter((c) => c.status === 'ready');
      if (!ready.length) {
        corpusSelect.innerHTML = '<option value="">— no ready corpora —</option>';
        resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No ready corpora available. Build one in the Sources tab first.</p>';
        return;
      }
      corpusSelect.innerHTML = ready.map((c) =>
        `<option value="${esc(c.id)}">${esc(c.name)}</option>`
      ).join('');
    } catch {
      corpusSelect.innerHTML = '<option value="">— error loading —</option>';
    }
  }

  async function search() {
    const corpusId = corpusSelect.value;
    const query = queryInput.value.trim();
    const k = parseInt(kSelect.value, 10);

    if (!corpusId) {
      resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">Select a ready corpus first.</p>';
      return;
    }
    if (!query) {
      resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">Enter a query to search.</p>';
      queryInput.focus();
      return;
    }

    resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">Searching…</p>';
    searchBtn.disabled = true;

    try {
      const res = await fetch(`${apiBase}/${encodeURIComponent(corpusId)}/query`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ query, k }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = data.results ?? [];
      if (!results.length) {
        resultsEl.innerHTML = '<p style="color:var(--text-muted,#888)">No results found.</p>';
        return;
      }
      resultsEl.innerHTML = results.map((r) => {
        const text = String(r.text ?? '');
        const truncated = text.length > 400 ? text.slice(0, 400) + '…' : text;
        const score = typeof r.score === 'number' ? r.score.toFixed(3) : String(r.score ?? '');
        return `
          <div class="result-card">
            <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.4rem">
              <span class="result-score">score: ${esc(score)}</span>
              <span class="result-source">${esc(r.source ?? '')} · chunk ${esc(String(r.index ?? r.chunkIndex ?? ''))}</span>
            </div>
            <div style="font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(truncated)}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      resultsEl.innerHTML = `<p style="color:var(--text-muted,#888)">Search failed: ${esc(String(err.message ?? err))}</p>`;
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', search);
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') search();
  });

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  loadCorpora();
}
