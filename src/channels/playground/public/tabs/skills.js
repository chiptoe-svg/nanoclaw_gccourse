import { showDraftBanner, hideDraftBanner } from '../draft-banner.js';

let originalSkills = null; // 'all' or string[]
let currentSkills = null;

export function mountSkills(el) {
  const folder = window.__pg.agent.folder;

  el.innerHTML = `
    <div class="skills-layout">
      <aside class="library-panel">
        <h3>Available skills</h3>
        <input id="skill-filter" placeholder="filter…" autocomplete="off">
        <div id="skills-list"></div>
        <button id="author-skill" class="btn btn-ghost">+ Author my own skill…</button>
      </aside>

      <section class="preview-panel">
        <header class="preview-header">
          <span id="skill-prev-title">Preview</span>
          <span id="skill-prev-meta" class="hint"></span>
        </header>
        <div class="file-pane">
          <ul id="file-tree" class="file-tree"></ul>
          <pre id="file-body" class="file-body">Click a skill to preview.</pre>
        </div>
        <footer class="preview-footer">
          <button id="add-to-active" class="btn btn-primary" disabled>+ Add to active →</button>
        </footer>
      </section>

      <section class="active-panel skills-active">
        <h3>Active skills (this agent)</h3>
        <ul id="active-skills" class="active-skills"></ul>
        <footer class="cost-rollup" id="cost-rollup">
          <div>Estimated cost impact: <strong id="rollup-tokens">—</strong></div>
          <div>Latency impact: <strong id="rollup-latency">—</strong></div>
        </footer>
      </section>
    </div>
  `;

  loadSkillLibrary(el, folder);
  loadActiveSkills(el, folder);
  wireFilter(el);
  wireAuthorButton(el);
}

let libraryCache = []; // populated by loadSkillLibrary

function loadSkillLibrary(el, folder) {
  fetch('/api/skills/library', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { entries: [] }))
    .then((data) => {
      libraryCache = data.entries || [];
      renderLibraryList(el);
    })
    .catch(() => { /* ignore */ });
}

function renderLibraryList(el) {
  const listEl = el.querySelector('#skills-list');
  listEl.innerHTML = '';
  const byCategory = {};
  for (const entry of libraryCache) {
    (byCategory[entry.category] = byCategory[entry.category] || []).push(entry);
  }
  for (const category of Object.keys(byCategory).sort()) {
    const section = document.createElement('div');
    section.className = 'lib-section';
    const heading = document.createElement('h4');
    heading.textContent = category;
    section.appendChild(heading);
    const ul = document.createElement('ul');
    for (const entry of byCategory[category]) {
      const li = document.createElement('li');
      li.className = 'lib-entry skill-entry';
      li.dataset.category = entry.category;
      li.dataset.name = entry.name;
      const costText = entry.costTokens != null ? ` (+~${entry.costTokens} tok)` : '';
      li.textContent = `🔧 ${entry.name}${costText}`;
      li.title = entry.description || '';
      if (entry.compatibility === 'incompatible') li.classList.add('skill-incompatible');
      if (entry.compatibility === 'partial') li.classList.add('skill-partial');
      li.addEventListener('click', () => loadSkillPreview(li.closest('.tab-body') || document, entry.category, entry.name));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    listEl.appendChild(section);
  }
}

let currentPreview = null; // { category, name }

function loadSkillPreview(el, category, name) {
  currentPreview = { category, name };
  // Update selected highlight.
  for (const li of el.querySelectorAll('.skill-entry')) li.classList.remove('selected');
  const selected = el.querySelector(`.skill-entry[data-category="${category}"][data-name="${name}"]`);
  if (selected) selected.classList.add('selected');
  // Title + meta.
  el.querySelector('#skill-prev-title').textContent = `Preview: ${category}/${name}`;
  const entry = libraryCache.find((e) => e.category === category && e.name === name);
  const metaParts = [];
  if (entry) {
    if (entry.compatibility) metaParts.push(entry.compatibility);
    if (entry.costTokens != null) metaParts.push(`~${entry.costTokens} tok/turn`);
    if (entry.latencyMs != null) metaParts.push(`+${entry.latencyMs}ms/turn`);
  }
  el.querySelector('#skill-prev-meta').textContent = metaParts.join(' · ');
  el.querySelector('#add-to-active').disabled = false;
  // File tree + default SKILL.md preview.
  fetch(`/api/skills/library/${encodeURIComponent(category)}/${encodeURIComponent(name)}/files`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { files: [] }))
    .then((data) => renderFileTree(el, data.files || []));
  loadFile(el, category, name, 'SKILL.md');
  // Wire add-to-active.
  el.querySelector('#add-to-active').onclick = () => addSkillToActive(el, name);
}

function renderFileTree(el, files) {
  const tree = el.querySelector('#file-tree');
  tree.innerHTML = '';
  for (const f of files) {
    if (f.isDir) continue; // only files are clickable
    const li = document.createElement('li');
    li.className = 'file-entry';
    li.textContent = `📄 ${f.path}`;
    li.dataset.path = f.path;
    if (f.path === 'SKILL.md') li.classList.add('selected');
    li.addEventListener('click', () => {
      if (!currentPreview) return;
      for (const x of tree.querySelectorAll('.file-entry')) x.classList.remove('selected');
      li.classList.add('selected');
      loadFile(el, currentPreview.category, currentPreview.name, f.path);
    });
    tree.appendChild(li);
  }
}

function loadFile(el, category, name, relPath) {
  fetch(`/api/skills/library/${encodeURIComponent(category)}/${encodeURIComponent(name)}/file?path=${encodeURIComponent(relPath)}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { text: '(not found)' }))
    .then((data) => { el.querySelector('#file-body').textContent = data.text || ''; });
}

function loadActiveSkills(el, folder) {
  fetch(`/api/drafts/${folder}/skills`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { skills: 'all' }))
    .then((data) => {
      currentSkills = data.skills;
      originalSkills = Array.isArray(currentSkills) ? [...currentSkills] : currentSkills;
      renderActiveList(el);
      recomputeRollup(el);
    });
}

function renderActiveList(el) {
  const ul = el.querySelector('#active-skills');
  ul.innerHTML = '';
  if (currentSkills === 'all') {
    const li = document.createElement('li');
    li.className = 'active-all';
    li.textContent = 'All skills enabled (container default)';
    ul.appendChild(li);
    return;
  }
  for (const skill of currentSkills) {
    const entry = libraryCache.find((e) => e.name === skill);
    const li = document.createElement('li');
    li.className = 'active-entry';
    const costText = entry && entry.costTokens != null ? `+~${entry.costTokens} tok` : '';
    li.innerHTML = `
      <span>🔧 ${escapeHtml(skill)}</span>
      <span class="active-cost">${costText}</span>
      <button class="active-remove" title="Remove">×</button>
    `;
    li.querySelector('.active-remove').addEventListener('click', () => {
      currentSkills = currentSkills.filter((s) => s !== skill);
      saveActive(el);
    });
    ul.appendChild(li);
  }
  if (currentSkills.length === 0) {
    const li = document.createElement('li');
    li.className = 'active-empty';
    li.textContent = '(no skills enabled — agent has no extra tools)';
    ul.appendChild(li);
  }
}

function addSkillToActive(el, name) {
  // When transitioning from the implicit "all" sentinel to an explicit
  // list, seed the list with every currently-known library skill before
  // appending the new one. The old behavior (reset to []) silently
  // *removed* every skill except the one being added — surprising and
  // destructive when "+ Add to active" reads as additive.
  if (currentSkills === 'all') {
    currentSkills = libraryCache.map((e) => e.name).filter((n) => typeof n === 'string');
  }
  if (currentSkills.includes(name)) return;
  currentSkills.push(name);
  saveActive(el);
}

function saveActive(el) {
  const folder = window.__pg.agent.folder;
  fetch(`/api/drafts/${folder}/skills`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ skills: currentSkills }),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then(() => {
      renderActiveList(el);
      recomputeRollup(el);
      if (JSON.stringify(currentSkills) !== JSON.stringify(originalSkills)) {
        showDraftBanner(`${window.__pg.agent.name} has unsaved skill changes.`);
      } else {
        hideDraftBanner();
      }
    });
}

function recomputeRollup(el) {
  let tokens = 0;
  let latency = 0;
  let unknown = false;
  const skills = Array.isArray(currentSkills) ? currentSkills : [];
  for (const name of skills) {
    const entry = libraryCache.find((e) => e.name === name);
    if (!entry) { unknown = true; continue; }
    if (entry.costTokens != null) tokens += entry.costTokens; else unknown = true;
    if (entry.latencyMs != null) latency += entry.latencyMs;
  }
  el.querySelector('#rollup-tokens').textContent =
    currentSkills === 'all' ? 'depends on what gets used' :
    skills.length === 0 ? 'none' :
    `+~${tokens} tok/turn${unknown ? ' (some skills missing cost metadata)' : ''}`;
  el.querySelector('#rollup-latency').textContent =
    currentSkills === 'all' ? 'depends' :
    skills.length === 0 ? '—' :
    `+~${latency}ms/turn`;
}

function wireFilter(el) {
  el.querySelector('#skill-filter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    for (const li of el.querySelectorAll('.skill-entry')) {
      const visible = !q || li.dataset.name.toLowerCase().includes(q);
      li.style.display = visible ? '' : 'none';
    }
  });
}

function wireAuthorButton(el) {
  el.querySelector('#author-skill').addEventListener('click', () => {
    alert('Skill authoring sub-flow — design pending. (v3 placeholder.)');
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
