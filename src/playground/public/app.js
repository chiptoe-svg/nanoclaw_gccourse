// NanoClaw Agent Playground — vanilla JS client.
//
// Three top-level modes: Test, Agent Persona, Skills. Each mode has its
// own layout. Switching modes via the segmented control in the top bar
// (or by calling setMode programmatically after certain actions).

const $ = (id) => document.getElementById(id);

// Base path prefix — empty when served direct at "/", "/playground" when
// served behind Caddy at "/playground/".
const BASE = location.pathname.replace(/\/$/, '').replace(/\/login$/, '');

const state = {
  status: null,
  pendingAttachments: [],
  selectedSkill: null,
  selectedPersona: null,      // { category, name, content }
  selectedLibrarySkill: null, // { category, name, content }
  activatedSkills: new Set(),
  globalHash: '',
  mode: 'test',
};

// --- API helper ---
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  if (res.status === 401) { window.location.href = BASE + '/login'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// Mode switching
// ============================================================
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const el of document.querySelectorAll('.mode')) {
    el.classList.toggle('active', el.id === `mode-${mode}`);
  }
  for (const btn of document.querySelectorAll('#mode-switcher .mode-btn')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  // Lazy-load data for the selected mode
  if (mode === 'persona') {
    loadPersonasTree();
  } else if (mode === 'skills') {
    loadSkills();
    loadLibraryTree();
  } else if (mode === 'live-trace') {
    initLiveTrace();
  }
}
for (const btn of document.querySelectorAll('#mode-switcher .mode-btn')) {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
}
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  if (e.key === '1') { e.preventDefault(); setMode('test'); }
  else if (e.key === '2') { e.preventDefault(); setMode('persona'); }
  else if (e.key === '3') { e.preventDefault(); setMode('skills'); }
  else if (e.key === '4') { e.preventDefault(); setMode('live-trace'); }
});

// ============================================================
// Sub-tabs (Agent / Global inside persona mode)
// ============================================================
for (const subtab of document.querySelectorAll('.subtab')) {
  subtab.addEventListener('click', () => {
    const parent = subtab.closest('.col-editor');
    for (const s of parent.querySelectorAll('.subtab')) s.classList.remove('active');
    for (const c of parent.querySelectorAll('.subtab-content')) c.classList.remove('active');
    subtab.classList.add('active');
    parent.querySelector(`.subtab-content[data-subtab="${subtab.dataset.subtab}"]`).classList.add('active');
    if (subtab.dataset.subtab === 'global') loadGlobal();
  });
}

// ============================================================
// Draft status + persona
// ============================================================
function addMessage(role, text, files) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  if (Array.isArray(files) && files.length > 0) {
    const chips = document.createElement('div');
    chips.className = 'file-chips';
    for (const f of files) {
      const a = document.createElement('a');
      a.className = 'file-chip';
      a.href = BASE + '/api/draft/files?path=' + encodeURIComponent(f.path);
      a.target = '_blank';
      a.innerHTML = `📎 ${escapeHtml(f.path)} <span class="size">${formatSize(f.size)}</span>`;
      chips.appendChild(a);
    }
    div.appendChild(chips);
  }
  $('messages').appendChild(div);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

function renderStatus() {
  const badge = $('status-badge');
  const s = state.status;
  if (!s) return;
  if (s.externalChange) {
    badge.textContent = '⚠ main changed externally';
    badge.className = 'status conflict';
  } else if (s.dirty) {
    badge.textContent = '● unsaved changes';
    badge.className = 'status';
  } else {
    badge.textContent = '✓ in sync with main';
    badge.className = 'status clean';
  }
  $('apply-btn').disabled = !s.dirty && !s.externalChange;
}

async function loadDraft() {
  const s = await api('GET', '/api/draft');
  state.status = s;
  $('persona-editor').value = s.persona;
  $('trace-level').value = s.traceLevel;
  $('active-draft-name').textContent = s.draftName || '…';
  $('active-target-name').textContent = s.targetFolder || '…';
  $('persona-path-hint').textContent = `groups/${s.draftName}/CLAUDE.md`;
  renderStatus();
}

// --- chat ---
$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  $('chat-input').value = '';

  if (state.pendingAttachments.length > 0) {
    try {
      await api('POST', '/api/draft/attachments', { files: state.pendingAttachments });
      state.pendingAttachments = [];
      $('attachments-list').innerHTML = '';
    } catch (err) {
      addMessage('error', 'Attachment upload failed: ' + err.message);
    }
  }

  addMessage('user', text);
  $('send-btn').disabled = true;
  try {
    const res = await api('POST', '/api/draft/messages', { text });
    if (res.reply) addMessage('assistant', res.reply, res.files);
    else if (res.files && res.files.length > 0) addMessage('assistant', '(agent produced files)', res.files);
    if (res.error) addMessage('error', res.error);
  } catch (err) {
    addMessage('error', err.message);
  } finally {
    $('send-btn').disabled = false;
  }
});

$('new-session-btn').addEventListener('click', () => {
  $('messages').innerHTML = '';
  $('trace-list').innerHTML = '';
  state.activatedSkills.clear();
});

$('file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    state.pendingAttachments.push({ name: file.name, base64: b64 });
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    chip.textContent = file.name;
    $('attachments-list').appendChild(chip);
  }
  e.target.value = '';
});

// --- persona editor ---
$('save-persona-btn').addEventListener('click', async () => {
  await api('PUT', '/api/draft/persona', { text: $('persona-editor').value });
  await loadDraft();
  const hint = $('persona-hint');
  hint.textContent = 'Saved.';
  setTimeout(() => { hint.textContent = ''; }, 3000);
});
$('diff-btn').addEventListener('click', async () => {
  const d = await api('GET', '/api/draft/diff');
  const view = $('diff-view');
  if (!d.changed) {
    view.textContent = '(no differences)';
  } else {
    view.textContent = `--- main\n+++ draft\n\n${d.a}\n------\n${d.b}`;
  }
  view.hidden = !view.hidden;
});

// --- apply (in-session, keeps session open) ---
$('apply-btn').addEventListener('click', async () => {
  if (!confirm('Apply draft to target group now? You can keep editing afterward.')) return;
  try {
    const res = await api('POST', '/api/draft/apply');
    alert(`Applied to ${res.targetFolder}.\nBackup: ${res.backupPath}\nSkills promoted: ${(res.skillsPromoted || []).join(', ') || 'none'}`);
    await loadDraft();
  } catch (err) {
    alert(err.message);
  }
});

// --- end session ---
$('end-session-btn').addEventListener('click', () => {
  $('end-session-dialog').hidden = false;
});
$('end-back-btn').addEventListener('click', () => {
  $('end-session-dialog').hidden = true;
});
$('end-save-btn').addEventListener('click', async () => {
  try {
    await api('POST', '/api/session/end', { action: 'save' });
    $('end-session-dialog').hidden = true;
    await showPicker();
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
});
$('end-cancel-btn').addEventListener('click', async () => {
  if (!confirm('Discard all edits made in this session?')) return;
  try {
    await api('POST', '/api/session/end', { action: 'cancel' });
    $('end-session-dialog').hidden = true;
    await showPicker();
  } catch (err) {
    alert('Cancel failed: ' + err.message);
  }
});

$('trace-level').addEventListener('change', async () => {
  await api('PUT', '/api/draft/trace-level', { level: $('trace-level').value });
});
$('logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  window.location.href = BASE + '/login';
});

// ============================================================
// Global CLAUDE.md editor
// ============================================================
async function loadGlobal() {
  const g = await api('GET', '/api/global');
  $('global-editor').value = g.content || '';
  state.globalHash = g.hash || '';
}
$('save-global-btn').addEventListener('click', async () => {
  const hint = $('global-hint');
  try {
    const res = await fetch(BASE + '/api/global', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: $('global-editor').value, knownHash: state.globalHash }),
    });
    const data = await res.json();
    if (res.status === 409) {
      hint.className = 'hint error';
      hint.textContent = 'Conflict: someone else edited this file. Reload to see their changes.';
      return;
    }
    if (!res.ok) throw new Error(data.error || 'save failed');
    state.globalHash = data.newHash;
    hint.className = 'hint';
    hint.textContent = data.backupPath ? 'Saved (prior version backed up).' : 'Saved.';
    setTimeout(() => { hint.textContent = ''; }, 4000);
  } catch (err) {
    hint.className = 'hint error';
    hint.textContent = err.message;
  }
});

// ============================================================
// Shared: insert text into a textarea at cursor position
// ============================================================
function insertIntoTextarea(textarea, text, hintEl) {
  if (!textarea) return;
  const existing = textarea.value;
  const draftHasFm = /^---\n[\s\S]*?\nname:/m.test(existing);
  const incomingHasFm = /^---\n[\s\S]*?\nname:/m.test(text);
  let warning = '';
  if (draftHasFm && incomingHasFm) {
    warning = 'Both your draft and the pasted fragment have `name:` frontmatter — clean up manually.';
  }

  const start = textarea.selectionStart ?? existing.length;
  const end = textarea.selectionEnd ?? existing.length;
  const before = existing.slice(0, start);
  const after = existing.slice(end);
  const needsLeadingNl = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
  const needsTrailingNl = after && !text.endsWith('\n\n') ? (text.endsWith('\n') ? '\n' : '\n\n') : '';
  textarea.value = before + needsLeadingNl + text + needsTrailingNl + after;
  const cursor = (before + needsLeadingNl + text).length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor);

  if (hintEl) {
    hintEl.className = 'hint' + (warning ? ' warn' : '');
    hintEl.textContent = warning || 'Inserted at cursor. Remember to Save.';
    setTimeout(() => { hintEl.textContent = ''; }, 6000);
  }
}

// ============================================================
// Shared: generic file tree renderer
//
//   entries: [{ category, name, title, description?, emoji? }]
//   onSelect: called with the entry when a file is clicked
//   selectedKey: `${category}/${name}` of the currently selected entry
//   filter: case-insensitive substring applied to title/category/description
//   openCategories: Set<string>  (mutated as user clicks headers)
// ============================================================
function renderFileTree(container, entries, options) {
  const { onSelect, selectedKey, filter, openCategories } = options;
  container.innerHTML = '';

  const q = (filter || '').toLowerCase();
  const matches = q
    ? entries.filter((e) =>
        e.title.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        (e.description || '').toLowerCase().includes(q),
      )
    : entries;

  if (matches.length === 0) {
    container.innerHTML = '<div style="color:#666; padding:12px; font-style:italic; font-size:12px;">No matches.</div>';
    return;
  }

  // Auto-open every category with at least one match while filtering
  if (q) {
    for (const e of matches) openCategories.add(e.category);
  }

  // Group
  const groups = new Map();
  for (const e of matches) {
    if (!groups.has(e.category)) groups.set(e.category, []);
    groups.get(e.category).push(e);
  }
  const sortedCategories = Array.from(groups.keys()).sort();

  for (const cat of sortedCategories) {
    const items = groups.get(cat).slice().sort((a, b) => a.title.localeCompare(b.title));
    const group = document.createElement('div');
    group.className = 'tree-group' + (openCategories.has(cat) ? ' open' : '');

    const header = document.createElement('div');
    header.className = 'tree-group-header';
    header.innerHTML = `
      <span class="chevron">▶</span>
      <span>${escapeHtml(cat.replace(/-/g, ' '))}</span>
      <span class="count">${items.length}</span>
    `;
    header.addEventListener('click', () => {
      group.classList.toggle('open');
      if (group.classList.contains('open')) openCategories.add(cat);
      else openCategories.delete(cat);
    });

    const body = document.createElement('div');
    body.className = 'tree-group-body';
    for (const e of items) {
      const file = document.createElement('div');
      file.className = 'tree-file';
      const key = `${e.category}/${e.name}`;
      if (key === selectedKey) file.classList.add('selected');
      file.innerHTML = `
        ${e.emoji ? `<span class="emoji">${escapeHtml(e.emoji)}</span>` : ''}
        <span class="name">${escapeHtml(e.title)}</span>
      `;
      file.addEventListener('click', () => onSelect(e));
      body.appendChild(file);
    }

    group.appendChild(header);
    group.appendChild(body);
    container.appendChild(group);
  }
}

// ============================================================
// Personas library (agency-agents) — Agent Persona mode
// ============================================================
let cachedPersonas = [];
const personaOpenCategories = new Set();

async function loadPersonasTree(refresh) {
  const tree = $('personas-tree');
  if (refresh || cachedPersonas.length === 0) {
    tree.innerHTML = '<div style="color:#666; padding:12px; font-size:12px;">Loading…</div>';
  }
  try {
    const res = await api('GET', '/api/personas' + (refresh ? '?refresh=1' : ''));
    cachedPersonas = res.entries || [];
    rerenderPersonaTree();
  } catch (err) {
    tree.innerHTML = `<div style="color:#ff6b6b; padding:12px; font-size:12px;">${escapeHtml(err.message)}</div>`;
  }
}

function rerenderPersonaTree() {
  const selectedKey = state.selectedPersona
    ? `${state.selectedPersona.category}/${state.selectedPersona.name}`
    : null;
  renderFileTree($('personas-tree'), cachedPersonas, {
    onSelect: (e) => openPersonaInViewer(e.category, e.name),
    selectedKey,
    filter: $('personas-filter').value,
    openCategories: personaOpenCategories,
  });
}

async function openPersonaInViewer(category, name) {
  const p = await api('GET', `/api/personas/${encodeURIComponent(category)}/${encodeURIComponent(name)}`);
  state.selectedPersona = { category, name, content: p.content };
  $('persona-viewer-empty').hidden = true;
  $('persona-viewer').hidden = false;
  $('persona-viewer-emoji').textContent = p.emoji || '🤖';
  $('persona-viewer-name').textContent = p.title;
  $('persona-viewer-path').textContent = `${category}/${name}.md`;
  $('persona-viewer-desc').textContent = p.description || '';
  $('persona-viewer-content').textContent = p.content;
  rerenderPersonaTree();
}

$('refresh-personas-btn').addEventListener('click', () => loadPersonasTree(true));
$('personas-filter').addEventListener('input', rerenderPersonaTree);

$('append-persona-btn').addEventListener('click', () => {
  if (!state.selectedPersona) return;
  insertIntoTextarea($('persona-editor'), state.selectedPersona.content, $('persona-hint'));
  // Make sure the Agent sub-tab is active so the user sees the result
  document.querySelector('.subtab[data-subtab="agent"]').click();
});
$('append-selection-btn').addEventListener('click', () => {
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  const preview = $('persona-viewer-content');
  if (text && preview.contains(sel.anchorNode)) {
    insertIntoTextarea($('persona-editor'), text, $('persona-hint'));
    document.querySelector('.subtab[data-subtab="agent"]').click();
  } else {
    const hint = $('persona-hint');
    hint.className = 'hint warn';
    hint.textContent = 'Select text inside the viewer first.';
    setTimeout(() => { hint.textContent = ''; }, 3000);
  }
});
$('load-persona-btn').addEventListener('click', async () => {
  if (!state.selectedPersona) return;
  if (!confirm('This overwrites the current draft persona. Continue?')) return;
  const { category, name } = state.selectedPersona;
  await api('POST', `/api/personas/${encodeURIComponent(category)}/${encodeURIComponent(name)}/load`, {});
  await loadDraft();
  document.querySelector('.subtab[data-subtab="agent"]').click();
});

// ============================================================
// Skills — Skills mode left column
// ============================================================
async function loadSkills() {
  const res = await api('GET', '/api/skills');
  state.cachedSkills = res.skills || [];
  renderSkills(state.cachedSkills);
  updateSkillsLabel();
  // Library's "already added" filter depends on the skills list, so
  // re-render the library tree too.
  if (cachedLibrary.length > 0) rerenderLibraryTree();
  loadAgentCreatedSkills();
}
function updateSkillsLabel() {
  // "(draft)" suffix while any skill has unpromoted local edits / additions.
  // origin === 'draft' or 'overlay' means the skill only exists in, or has
  // been modified in, .nanoclaw/playground/draft/skills/.
  const anyDraft = (state.cachedSkills || []).some(
    (s) => s.origin === 'draft' || s.origin === 'overlay',
  );
  $('skills-label').textContent = anyDraft ? 'Global skills (draft)' : 'Global skills';
}
function renderSkills(skills) {
  const ul = $('skills-list');
  ul.innerHTML = '';
  if (skills.length === 0) {
    ul.innerHTML = '<div id="skills-list-empty">No skills yet. Add one from the library or create a new one.</div>';
    return;
  }
  const sorted = skills.slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const s of sorted) {
    const li = document.createElement('li');
    if (state.activatedSkills.has(s.name)) li.classList.add('activated');
    if (state.selectedSkill === s.name) li.classList.add('selected');
    li.textContent = s.name;
    li.title = s.description || '';
    li.addEventListener('click', () => openSkill(s.name));
    ul.appendChild(li);
  }
}
async function openSkill(name) {
  const s = await api('GET', `/api/skills/${encodeURIComponent(name)}`);
  state.selectedSkill = name;
  $('skill-editor').hidden = false;
  $('skill-editor-name').textContent = name;
  $('skill-editor-origin').textContent = s.origin;
  $('skill-editor-content').value = s.content;
}
$('skill-editor-close').addEventListener('click', () => {
  $('skill-editor').hidden = true;
  state.selectedSkill = null;
});
$('save-skill-btn').addEventListener('click', async () => {
  if (!state.selectedSkill) return;
  await api('PUT', `/api/skills/${encodeURIComponent(state.selectedSkill)}`, {
    content: $('skill-editor-content').value,
  });
  await loadSkills();
});
$('delete-skill-btn').addEventListener('click', async () => {
  if (!state.selectedSkill) return;
  if (!confirm(`Remove "${state.selectedSkill}" from the skill library? You can re-add it later from Available skills.`)) return;
  await api('DELETE', `/api/skills/${encodeURIComponent(state.selectedSkill)}`);
  $('skill-editor').hidden = true;
  state.selectedSkill = null;
  await loadSkills();
});
$('new-skill-btn').addEventListener('click', async () => {
  const name = prompt('Skill name (lowercase, letters/digits/-/_):');
  if (!name) return;
  const description = prompt('One-line description:') || '';
  try {
    await api('POST', '/api/skills', { name, description });
    await loadSkills();
    openSkill(name);
  } catch (err) {
    alert(err.message);
  }
});
$('refresh-skills-btn').addEventListener('click', loadSkills);

// --- Agent-created skills ---
async function loadAgentCreatedSkills() {
  try {
    const res = await api('GET', '/api/skills/agent-created');
    const skills = res.skills || [];
    const section = $('agent-skills-section');
    const ul = $('agent-skills-list');
    if (skills.length === 0) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    ul.innerHTML = '';
    for (const s of skills) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span>${escapeHtml(s.name)}</span>
        <button class="promote-btn" data-name="${escapeHtml(s.name)}">Add to library</button>
      `;
      li.title = s.description || '';
      ul.appendChild(li);
    }
    ul.querySelectorAll('.promote-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.name;
        try {
          await api('POST', `/api/skills/agent-created/${encodeURIComponent(name)}/promote`);
          await loadSkills();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch {
    // Silently ignore — agent skills are a nice-to-have
  }
}

// ============================================================
// Multi-source skill library — Skills mode middle column
//
// Data shape:
//   cachedSources = [{ source: {id,name,repo}, skills: [{name, description, files: [{path,size,isDir}]}], error? }]
//
// Tree:
//   Source (click chevron to expand)
//     Skill folder (click name to open SKILL.md in viewer, click chevron to see files)
//       file.md  (click to view in right pane)
// ============================================================
let cachedSources = [];
const sourceOpen = new Set();  // set of source ids that are expanded
const skillOpen = new Set();   // set of "${sourceId}/${skillName}" skills expanded to show files

async function loadLibraryTree(refresh) {
  const tree = $('library-tree');
  if (refresh || cachedSources.length === 0) {
    tree.innerHTML = '<div style="color:#666; padding:12px; font-size:12px;">Loading…</div>';
  }
  try {
    const res = await api('GET', '/api/skill-sources' + (refresh ? '?refresh=1' : ''));
    cachedSources = res.sources || [];
    // First source auto-opens so the user sees something.
    if (sourceOpen.size === 0 && cachedSources[0]) sourceOpen.add(cachedSources[0].source.id);
    rerenderLibraryTree();
  } catch (err) {
    tree.innerHTML = `<div style="color:#ff6b6b; padding:12px; font-size:12px;">${escapeHtml(err.message)}</div>`;
  }
}

function rerenderLibraryTree() {
  const tree = $('library-tree');
  tree.innerHTML = '';
  const q = $('library-filter').value.toLowerCase();
  const installed = new Set((state.cachedSkills || []).map((s) => s.name));
  const selKey = state.selectedLibrarySkill
    ? `${state.selectedLibrarySkill.sourceId}/${state.selectedLibrarySkill.name}`
    : null;
  const selFileKey = selKey && state.selectedLibrarySkill.file
    ? `${selKey}::${state.selectedLibrarySkill.file}`
    : null;

  for (const listing of cachedSources) {
    const { source, skills, error } = listing;

    const skillsFiltered = skills.filter((s) => {
      if (installed.has(s.name)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q) ||
        source.name.toLowerCase().includes(q)
      );
    });

    // While filtering, force-open matching sources and skills
    if (q) {
      if (skillsFiltered.length > 0) sourceOpen.add(source.id);
    }

    const srcDiv = document.createElement('div');
    srcDiv.className = 'tree-source' + (sourceOpen.has(source.id) ? ' open' : '');

    const srcHeader = document.createElement('div');
    srcHeader.className = 'tree-source-header';
    srcHeader.innerHTML = `
      <span class="chevron">▶</span>
      <span>${escapeHtml(source.name)}</span>
      <span class="count">${skillsFiltered.length}</span>
      ${source.id !== 'anthropic' ? '<span class="remove" title="Remove source">×</span>' : ''}
    `;
    srcHeader.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove')) {
        e.stopPropagation();
        removeSkillSource(source.id, source.name);
        return;
      }
      srcDiv.classList.toggle('open');
      if (srcDiv.classList.contains('open')) sourceOpen.add(source.id);
      else sourceOpen.delete(source.id);
    });
    srcDiv.appendChild(srcHeader);

    const srcBody = document.createElement('div');
    srcBody.className = 'tree-source-body';
    if (error) {
      srcBody.innerHTML = `<div class="tree-source-error">${escapeHtml(error)}</div>`;
    } else if (skillsFiltered.length === 0) {
      srcBody.innerHTML = `<div class="tree-source-error">No available skills${q ? ' matching filter' : installed.size ? ' (all already added)' : ''}.</div>`;
    } else {
      for (const skill of skillsFiltered) {
        const skillKey = `${source.id}/${skill.name}`;
        const skillDiv = document.createElement('div');
        skillDiv.className = 'tree-skill' + (skillOpen.has(skillKey) ? ' open' : '');

        const skillHeader = document.createElement('div');
        skillHeader.className = 'tree-skill-header' +
          (selKey === skillKey && !selFileKey ? ' selected' : '');
        skillHeader.innerHTML = `
          <span class="chevron">▶</span>
          <span class="icon">📁</span>
          <span class="name">${escapeHtml(skill.name)}</span>
        `;
        skillHeader.title = skill.description || '';
        skillHeader.addEventListener('click', (e) => {
          // Click on chevron only toggles; click on name both opens
          // SKILL.md and toggles expansion.
          if (e.target.classList.contains('chevron')) {
            skillDiv.classList.toggle('open');
            if (skillDiv.classList.contains('open')) skillOpen.add(skillKey);
            else skillOpen.delete(skillKey);
            return;
          }
          skillDiv.classList.add('open');
          skillOpen.add(skillKey);
          openSourceFileInViewer(source, skill, 'SKILL.md');
        });
        skillDiv.appendChild(skillHeader);

        const skillBody = document.createElement('div');
        skillBody.className = 'tree-skill-body';
        for (const file of skill.files) {
          if (file.isDir) continue; // directories shown inline via their contents
          const leaf = document.createElement('div');
          leaf.className = 'tree-leaf' +
            (selFileKey === `${skillKey}::${file.path}` ? ' selected' : '');
          const icon = file.path === 'SKILL.md' ? '⭐' : '📄';
          leaf.innerHTML = `
            <span class="icon">${icon}</span>
            <span>${escapeHtml(file.path)}</span>
          `;
          leaf.addEventListener('click', () => {
            openSourceFileInViewer(source, skill, file.path);
          });
          skillBody.appendChild(leaf);
        }
        skillDiv.appendChild(skillBody);
        srcBody.appendChild(skillDiv);
      }
    }
    srcDiv.appendChild(srcBody);
    tree.appendChild(srcDiv);
  }
}

async function openSourceFileInViewer(source, skill, filePath) {
  const url = `/api/skill-sources/${encodeURIComponent(source.id)}/skill/${encodeURIComponent(skill.name)}/file?path=${encodeURIComponent(filePath)}`;
  try {
    const res = await api('GET', url);
    state.selectedLibrarySkill = {
      sourceId: source.id,
      sourceName: source.name,
      name: skill.name,
      file: filePath,
      content: res.content,
      description: skill.description,
    };
    $('library-viewer-empty').hidden = true;
    $('library-viewer').hidden = false;
    $('library-viewer-name').textContent = skill.name;
    $('library-viewer-path').textContent = `${source.name} / ${skill.name} / ${filePath}`;
    const badge = $('library-viewer-badge');
    // Compatibility badge only applies when viewing a SKILL.md — hide otherwise.
    if (filePath === 'SKILL.md') {
      badge.textContent = 'compatible';
      badge.className = 'tag compat-compatible';
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
    $('library-viewer-content').textContent = res.content;
    rerenderLibraryTree();
  } catch (err) {
    alert(err.message);
  }
}

async function removeSkillSource(id, name) {
  if (!confirm(`Remove source "${name}"? Its local clone will be deleted.`)) return;
  try {
    await api('DELETE', `/api/skill-sources/${encodeURIComponent(id)}`);
    sourceOpen.delete(id);
    await loadLibraryTree();
  } catch (err) {
    alert(err.message);
  }
}

$('refresh-library-inline-btn').addEventListener('click', () => loadLibraryTree(true));
$('library-filter').addEventListener('input', rerenderLibraryTree);

$('add-source-btn').addEventListener('click', async () => {
  const name = prompt('Source name (e.g. "Agency agents"):');
  if (!name) return;
  const repo = prompt('Git repo URL:');
  if (!repo) return;
  const subpath = prompt('Subdirectory within the repo where skills live (optional):') || '';
  try {
    await api('POST', '/api/skill-sources', { name, repo, path: subpath || undefined });
    await loadLibraryTree(false);
  } catch (err) {
    alert('Failed to add source: ' + err.message);
  }
});

$('library-inline-import-btn').addEventListener('click', async () => {
  const sel = state.selectedLibrarySkill;
  if (!sel) return;
  try {
    await api('POST', `/api/skill-sources/${encodeURIComponent(sel.sourceId)}/skill/${encodeURIComponent(sel.name)}/import`, {});
    await loadSkills();
  } catch (err) {
    if (err.message.includes('already exists')) {
      if (confirm('Already in draft. Overwrite?')) {
        await api('POST', `/api/skill-sources/${encodeURIComponent(sel.sourceId)}/skill/${encodeURIComponent(sel.name)}/import`, { overwrite: true });
        await loadSkills();
      }
    } else {
      alert(err.message);
    }
  }
});

// ============================================================
// Trace WebSocket
// ============================================================
function connectTrace() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}${BASE}/ws/trace`;
  let ws;
  const open = () => {
    ws = new WebSocket(url);
    ws.onerror = () => ws.close();
    ws.onclose = () => setTimeout(open, 2000);
    ws.onmessage = (ev) => handleTraceEvent(ev.data);
  };
  open();
}

function handleTraceEvent(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return; }
  renderEvent(event, $('trace-list'));
  if (event.type === 'skill_invoked' && event.name) {
    state.activatedSkills.add(event.name);
    if (state.cachedSkills) renderSkills(state.cachedSkills);
  }
}

function renderEvent(e, target) {
  const div = document.createElement('div');
  div.className = `event ${e.type || 'unknown'}`;
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
  let body = '';
  if (e.type === 'tool_call') {
    body = `<div class="type">${ts} tool_call: ${escapeHtml(e.name || '')}</div><details><summary>args</summary><pre>${escapeHtml(JSON.stringify(e.args || {}, null, 2))}</pre></details>`;
  } else if (e.type === 'tool_result') {
    body = `<div class="type">${ts} tool_result</div><details><summary>output</summary><pre>${escapeHtml(String(e.output || '').slice(0, 4000))}</pre></details>`;
  } else if (e.type === 'assistant_message') {
    body = `<div class="type">${ts} assistant</div><pre>${escapeHtml(e.text || '')}</pre>`;
  } else if (e.type === 'user_message') {
    body = `<div class="type">${ts} user</div><pre>${escapeHtml(e.text || '')}</pre>`;
  } else if (e.type === 'system_prompt') {
    body = `<div class="type">${ts} system_prompt</div><details><summary>show</summary><pre>${escapeHtml((e.text || '').slice(0, 4000))}</pre></details>`;
  } else if (e.type === 'skill_invoked') {
    body = `<div class="type">${ts} skill_invoked: ${escapeHtml(e.name || '')}</div>`;
  } else if (e.type === 'session_end') {
    const inTok = e.inputTokens || 0;
    const outTok = e.outputTokens || 0;
    body = `<div class="type">${ts} session_end — ${inTok} in / ${outTok} out</div>`;
  } else {
    body = `<div class="type">${ts} ${escapeHtml(e.type || 'event')}</div><pre>${escapeHtml(JSON.stringify(e, null, 2))}</pre>`;
  }
  div.innerHTML = body;
  target.appendChild(div);
  target.scrollTop = target.scrollHeight;
}

$('trace-clear').addEventListener('click', () => {
  $('trace-list').innerHTML = '';
});

// ============================================================
// Live Trace (any group)
// ============================================================
const liveTrace = {
  ws: null,
  group: null,
  groupsLoaded: false,
  reconnectTimer: null,
};

async function initLiveTrace() {
  if (!liveTrace.groupsLoaded) {
    try {
      const data = await api('GET', '/api/groups');
      const select = $('live-trace-group');
      select.innerHTML = '';
      const seen = new Set();
      const opts = [];
      if (data.activeDraft) {
        opts.push({ value: data.activeDraft, label: `${data.activeDraft} (draft)` });
        seen.add(data.activeDraft);
      }
      for (const g of (data.groups || [])) {
        if (seen.has(g.folder)) continue;
        opts.push({ value: g.folder, label: `${g.name} (${g.folder})` });
        seen.add(g.folder);
      }
      for (const o of opts) {
        const el = document.createElement('option');
        el.value = o.value;
        el.textContent = o.label;
        select.appendChild(el);
      }
      liveTrace.groupsLoaded = true;
      if (opts.length > 0) {
        liveTrace.group = opts[0].value;
        select.value = liveTrace.group;
        connectLiveTrace(liveTrace.group);
      } else {
        $('live-trace-status').textContent = 'No groups available.';
      }
    } catch (err) {
      $('live-trace-status').textContent = 'Failed to load groups: ' + err.message;
    }
  }
}

function connectLiveTrace(group) {
  if (liveTrace.ws) {
    try { liveTrace.ws.close(); } catch { /* ignore */ }
    liveTrace.ws = null;
  }
  if (liveTrace.reconnectTimer) {
    clearTimeout(liveTrace.reconnectTimer);
    liveTrace.reconnectTimer = null;
  }
  $('live-trace-list').innerHTML = '';
  $('live-trace-status').textContent = `connecting → ${group}`;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}${BASE}/ws/trace?group=${encodeURIComponent(group)}`;
  const ws = new WebSocket(url);
  liveTrace.ws = ws;
  ws.onopen = () => { $('live-trace-status').textContent = `live → ${group}`; };
  ws.onmessage = (ev) => {
    let event;
    try { event = JSON.parse(ev.data); } catch { return; }
    renderEvent(event, $('live-trace-list'));
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  ws.onclose = () => {
    if (liveTrace.ws !== ws) return;
    $('live-trace-status').textContent = `disconnected → ${group} (retrying)`;
    liveTrace.reconnectTimer = setTimeout(() => {
      if (liveTrace.group === group) connectLiveTrace(group);
    }, 2000);
  };
}

$('live-trace-group').addEventListener('change', () => {
  liveTrace.group = $('live-trace-group').value;
  connectLiveTrace(liveTrace.group);
});

$('live-trace-clear').addEventListener('click', () => {
  $('live-trace-list').innerHTML = '';
});

// ============================================================
// Session picker
// ============================================================
async function showPicker() {
  $('workspace-root').hidden = true;
  $('picker').hidden = false;
  const list = $('picker-list');
  list.innerHTML = '<li style="justify-content:center;color:#888;">Loading…</li>';
  try {
    const res = await api('GET', '/api/drafts');
    const drafts = res.drafts || [];
    list.innerHTML = '';
    if (drafts.length === 0) {
      $('picker-empty').hidden = false;
      return;
    }
    $('picker-empty').hidden = true;
    for (const d of drafts) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div>
          <div class="picker-name">${escapeHtml(d.name)}</div>
          <div class="picker-target">→ groups/${escapeHtml(d.target)}/</div>
        </div>
        <span class="picker-target">${d.hasPersona ? '' : '(empty)'}</span>
      `;
      li.addEventListener('click', () => startSession(d.name));
      list.appendChild(li);
    }
  } catch (err) {
    list.innerHTML = `<li style="color:#ff6b6b;">${escapeHtml(err.message)}</li>`;
  }
}

async function startSession(draftName) {
  try {
    await api('POST', '/api/session/start', { draft: draftName });
    await showWorkspace();
  } catch (err) {
    alert('Could not start session: ' + err.message);
  }
}

async function showWorkspace() {
  $('picker').hidden = true;
  $('workspace-root').hidden = false;
  await loadDraft();
  if (!state.traceConnected) {
    connectTrace();
    state.traceConnected = true;
  }
  setMode('test');
  // Reset chat pane for a fresh session
  $('messages').innerHTML = '';
  $('trace-list').innerHTML = '';
  state.activatedSkills.clear();
}

$('picker-refresh-btn').addEventListener('click', () => showPicker());
$('picker-logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  window.location.href = BASE + '/login';
});

// ============================================================
// Boot
// ============================================================
(async () => {
  try {
    const res = await api('GET', '/api/drafts');
    if (res.active) {
      await showWorkspace();
    } else {
      await showPicker();
    }
  } catch (err) {
    console.error(err);
    await showPicker();
  }
})();
