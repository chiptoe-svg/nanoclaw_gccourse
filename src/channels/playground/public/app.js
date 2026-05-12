// NanoClaw Playground client.

let activeDraft = null;
let eventSource = null;
let personaOriginal = '';

const $ = (id) => document.getElementById(id);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Escape HTML to safely render user-supplied / agent-supplied text. Used
// as the first pass before applying our tiny markdown subset, so any
// HTML tags in the source render as literal characters, not markup.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal markdown subset for agent chat bubbles. Order matters: fenced
// code blocks first (with placeholders so their contents don't get
// re-formatted), then inline code, then bold/italic, then line breaks.
// User and tool bubbles stay as plain text via the textContent path.
function renderAgentMarkdown(text) {
  const codeBlocks = [];
  let s = text.replace(/```([a-zA-Z0-9_+.-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang, code });
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\\])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\n/g, '<br>');
  s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => {
    const { code } = codeBlocks[+i];
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  });
  return s;
}

function logChat(role, text) {
  const li = document.createElement('li');
  li.className = role;
  if (role === 'agent') {
    li.innerHTML = renderAgentMarkdown(text);
  } else {
    li.textContent = text;
  }
  $('chat-log').appendChild(li);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

// ── Picker ────────────────────────────────────────────────────────────────

async function refreshPicker() {
  try {
    const [drafts, groups] = await Promise.all([api('GET', '/api/drafts'), api('GET', '/api/groups')]);
    renderDrafts(drafts);
    renderGroups(groups, drafts);
  } catch (err) {
    toast(`Refresh failed: ${err.message}`, 'error');
  }
}

function renderDrafts(drafts) {
  const list = $('drafts-list');
  list.innerHTML = '';
  $('picker-empty').hidden = drafts.length > 0;
  for (const { draft, target } of drafts) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="name">${draft.folder}</div>
        <div class="meta">→ ${target ? target.folder : '(target deleted)'} · ${draft.agent_provider || 'claude'}</div>
      </div>
      <div class="actions">
        <button data-action="open" data-folder="${draft.folder}" class="primary">Open</button>
        <button data-action="discard" data-folder="${draft.folder}">Discard</button>
      </div>`;
    list.appendChild(li);
  }
  list.onclick = async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const folder = btn.dataset.folder;
    const action = btn.dataset.action;
    if (action === 'open') openDraft(folder);
    if (action === 'discard') {
      if (!confirm(`Discard ${folder}?`)) return;
      try {
        await api('DELETE', `/api/drafts/${folder}`);
        toast(`Discarded ${folder}`);
        await refreshPicker();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  };
}

function renderGroups(groups, drafts) {
  const list = $('groups-list');
  list.innerHTML = '';
  $('groups-empty').hidden = groups.length > 0;
  const draftedTargets = new Set(drafts.map((d) => d.target?.folder).filter(Boolean));
  for (const g of groups) {
    const has = draftedTargets.has(g.folder);
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="name">${g.folder}</div>
        <div class="meta">${g.agent_provider || 'claude'} · ${g.model || '(provider default)'}</div>
      </div>
      <div class="actions">
        <button data-folder="${g.folder}" ${has ? 'disabled' : ''}>${has ? 'Has draft' : 'Create draft'}</button>
      </div>`;
    list.appendChild(li);
  }
  list.onclick = async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn || btn.disabled) return;
    const folder = btn.dataset.folder;
    try {
      const draft = await api('POST', '/api/drafts', { targetFolder: folder });
      toast(`Created ${draft.folder}`);
      await refreshPicker();
      openDraft(draft.folder);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

// ── Workspace ─────────────────────────────────────────────────────────────

async function openDraft(folder) {
  activeDraft = folder;
  $('picker').hidden = true;
  $('workspace').hidden = false;
  $('active-info').hidden = false;
  $('active-draft-name').textContent = folder;
  const target = folder.replace(/^draft_/, '');
  $('active-target-name').textContent = target;
  $('chat-log').innerHTML = '';
  switchMode('chat');
  refreshStatusBadge();
  await refreshProviderToggle();

  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/drafts/${folder}/stream`);
  eventSource.addEventListener('message', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const text = extractText(data.content);
      if (text) logChat('agent', text);
    } catch {
      logChat('error', ev.data);
    }
  });
  eventSource.addEventListener('error', () => {
    toast('Stream disconnected; reconnecting…');
  });
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content) return content.text;
  return JSON.stringify(content);
}

async function endSession() {
  if (eventSource) eventSource.close();
  eventSource = null;
  activeDraft = null;
  $('workspace').hidden = true;
  $('picker').hidden = false;
  $('active-info').hidden = true;
  await refreshPicker();
}

async function applyAndEnd() {
  if (!activeDraft) return;
  if (!confirm(`Apply ${activeDraft} to its target and end session?`)) return;
  try {
    await api('POST', `/api/drafts/${activeDraft}/apply`, {});
    toast('Applied to target.');
    await endSession();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Tab switcher ──────────────────────────────────────────────────────────

function switchMode(mode) {
  for (const btn of document.querySelectorAll('#mode-tabs .tab')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  for (const pane of document.querySelectorAll('.mode')) {
    pane.hidden = pane.id !== `mode-${mode}`;
    pane.classList.toggle('active', pane.id === `mode-${mode}`);
  }
  if (mode === 'persona') loadPersona();
  if (mode === 'diff') loadDiff();
  if (mode === 'skills') loadSkills();
  if (mode === 'files') loadFilesList();
}

// ── Persona pane ─────────────────────────────────────────────────────────

async function loadPersona() {
  if (!activeDraft) return;
  try {
    const { text } = await api('GET', `/api/drafts/${activeDraft}/persona`);
    personaOriginal = text;
    $('persona-text').value = text;
    $('persona-save-btn').disabled = true;
    $('persona-status').textContent = `${text.length} bytes`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function savePersona() {
  if (!activeDraft) return;
  const text = $('persona-text').value;
  try {
    const { bytes } = await api('PUT', `/api/drafts/${activeDraft}/persona`, { text });
    personaOriginal = text;
    $('persona-save-btn').disabled = true;
    $('persona-status').textContent = `${bytes} bytes saved`;
    toast('Persona saved.');
    refreshStatusBadge();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('persona-text').addEventListener?.('input', () => {
  $('persona-save-btn').disabled = $('persona-text').value === personaOriginal;
});

// ── Diff pane ─────────────────────────────────────────────────────────────

async function loadDiff() {
  if (!activeDraft) return;
  try {
    const { diff, status } = await api('GET', `/api/drafts/${activeDraft}/diff`);
    if (!diff.personaChanged && !diff.containerJsonChanged) {
      $('diff-output').innerHTML = '<div class="empty">No changes — draft is in sync with target.</div>';
      $('diff-status').textContent = 'in sync';
      return;
    }
    $('diff-status').textContent = status.targetExists ? 'changes pending' : '⚠ target deleted';

    const sections = [];
    if (diff.personaChanged) {
      sections.push(renderTextDiff('CLAUDE.local.md', diff.targetPersona, diff.draftPersona));
    }
    if (diff.containerJsonChanged) {
      sections.push(renderTextDiff('container.json', diff.targetContainerJson, diff.draftContainerJson));
    }
    $('diff-output').innerHTML = sections.join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderTextDiff(label, before, after) {
  const beforeText = before ?? '(missing)';
  const afterText = after ?? '(missing)';
  return `
    <h3>${label}</h3>
    <div class="diff-pair">
      <div class="diff-side">
        <div class="diff-label">target</div>
        <pre>${escapeHtml(beforeText)}</pre>
      </div>
      <div class="diff-side">
        <div class="diff-label">draft</div>
        <pre>${escapeHtml(afterText)}</pre>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── Files pane ───────────────────────────────────────────────────────────

let activeFile = null;
let activeFileOriginal = '';

async function loadFilesList() {
  if (!activeDraft) return;
  try {
    const { files } = await api('GET', `/api/drafts/${activeDraft}/files`);
    const list = $('files-list');
    list.innerHTML = '';
    if (files.length === 0) {
      list.innerHTML = '<div class="empty">No files yet.</div>';
      return;
    }
    for (const f of files) {
      const row = document.createElement('div');
      row.className = 'file-row';
      if (f.name === activeFile) row.classList.add('active');
      if (f.name === activeFile && $('files-text').value !== activeFileOriginal) {
        row.classList.add('dirty');
      }
      row.dataset.name = f.name;
      row.innerHTML = `<div class="file-name">${escapeHtml(f.name)}</div><div class="file-meta">${f.size} bytes</div>`;
      list.appendChild(row);
    }
    list.onclick = async (ev) => {
      const row = ev.target.closest('.file-row');
      if (!row) return;
      await openFile(row.dataset.name);
    };
    $('files-status').textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openFile(name) {
  try {
    const { text } = await api('GET', `/api/drafts/${activeDraft}/files/${encodeURIComponent(name)}`);
    activeFile = name;
    activeFileOriginal = text;
    $('files-text').value = text;
    $('files-save-btn').disabled = true;
    for (const row of document.querySelectorAll('#files-list .file-row')) {
      row.classList.toggle('active', row.dataset.name === name);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveActiveFile() {
  if (!activeFile) return;
  try {
    const text = $('files-text').value;
    await api('PUT', `/api/drafts/${activeDraft}/files/${encodeURIComponent(activeFile)}`, { text });
    activeFileOriginal = text;
    $('files-save-btn').disabled = true;
    // Clear the dirty dot on the just-saved row.
    for (const row of document.querySelectorAll('#files-list .file-row')) {
      if (row.dataset.name === activeFile) row.classList.remove('dirty');
    }
    toast(`Saved ${activeFile}`);
    refreshStatusBadge();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('files-text').addEventListener?.('input', () => {
  const dirty = $('files-text').value !== activeFileOriginal;
  $('files-save-btn').disabled = !dirty;
  // Reflect the dirty state on the active file row so the user sees the
  // dot indicator the moment they type, not on the next refresh.
  for (const row of document.querySelectorAll('#files-list .file-row')) {
    if (row.dataset.name === activeFile) row.classList.toggle('dirty', dirty);
  }
});
$('files-save-btn').addEventListener?.('click', saveActiveFile);
$('files-refresh-btn').addEventListener?.('click', loadFilesList);

// ── Skills pane ──────────────────────────────────────────────────────────

let skillsState = { enabled: 'all', library: [] };

async function loadSkills(refresh = false) {
  if (!activeDraft) return;
  try {
    const [enabled, lib] = await Promise.all([
      api('GET', `/api/drafts/${activeDraft}/skills`),
      api('GET', `/api/skills/library${refresh ? '?refresh=1' : ''}`),
    ]);
    skillsState.enabled = enabled.skills;
    skillsState.library = lib.entries;
    $('skills-status').textContent = lib.cache.exists
      ? `library cached (last updated ${new Date(lib.cache.mtime).toLocaleString()})`
      : 'library not yet cloned — click Refresh library';
    renderSkillsPane();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSkillsPane() {
  const enabled = skillsState.enabled;
  $('skills-all-toggle').checked = enabled === 'all';

  const enabledList = $('skills-enabled-list');
  enabledList.innerHTML = '';
  if (enabled === 'all') {
    enabledList.innerHTML = '<div class="empty">Allow-all is on — all installed skills available.</div>';
  } else if (enabled.length === 0) {
    enabledList.innerHTML = '<div class="empty">No skills enabled.</div>';
  } else {
    for (const name of enabled) {
      const row = document.createElement('div');
      row.className = 'skill-row';
      row.innerHTML = `<div><div class="name">${name}</div></div>
        <button data-action="disable" data-name="${name}">Disable</button>`;
      enabledList.appendChild(row);
    }
  }

  const libList = $('skills-library-list');
  libList.innerHTML = '';
  if (skillsState.library.length === 0) {
    libList.innerHTML = '<div class="empty">Library not yet loaded.</div>';
  } else {
    for (const e of skillsState.library) {
      const isEnabled = enabled !== 'all' && enabled.includes(e.name);
      const row = document.createElement('div');
      row.className = 'skill-row';
      row.innerHTML = `<div>
        <div class="name">${e.name}</div>
        <div class="meta">${e.category} — ${e.description}</div>
      </div>
      <span class="compat-badge ${e.compatibility}">${e.compatibility}</span>
      <button data-action="${isEnabled ? 'disable' : 'enable'}" data-name="${e.name}" ${enabled === 'all' ? 'disabled' : ''}>
        ${isEnabled ? 'Disable' : 'Enable'}
      </button>`;
      libList.appendChild(row);
    }
  }
}

async function setSkills(skills) {
  await api('PUT', `/api/drafts/${activeDraft}/skills`, { skills });
  skillsState.enabled = skills;
  renderSkillsPane();
}

$('skills-all-toggle').addEventListener?.('change', async (ev) => {
  const wantAll = ev.target.checked;
  try {
    if (wantAll) await setSkills('all');
    else await setSkills([]);
    toast(wantAll ? 'Enabled all skills.' : 'Disabled all (custom list).');
  } catch (err) { toast(err.message, 'error'); }
});

$('skills-refresh-btn').addEventListener?.('click', () => loadSkills(true));

document.body.addEventListener('click', async (ev) => {
  const btn = ev.target.closest?.('.skills-list .skill-row button');
  if (!btn) return;
  const action = btn.dataset.action;
  const name = btn.dataset.name;
  if (!name) return;
  try {
    let next;
    const cur = skillsState.enabled === 'all' ? [] : [...skillsState.enabled];
    if (action === 'enable' && !cur.includes(name)) next = [...cur, name];
    else if (action === 'disable') next = cur.filter((n) => n !== name);
    else return;
    await setSkills(next);
  } catch (err) { toast(err.message, 'error'); }
});

// ── Provider toggle ──────────────────────────────────────────────────────

async function refreshProviderToggle() {
  if (!activeDraft) return;
  // Read current provider from the drafts list (it's on the agent_group row).
  try {
    const drafts = await api('GET', '/api/drafts');
    const entry = drafts.find((d) => d.draft.folder === activeDraft);
    const current = entry?.draft.agent_provider || 'claude';
    setActiveProviderBtn(current);
  } catch {
    /* ignore */
  }
}

function setActiveProviderBtn(provider) {
  for (const btn of document.querySelectorAll('#provider-toggle .toggle')) {
    btn.classList.toggle('active', btn.dataset.provider === provider);
  }
}

async function switchProvider(provider) {
  if (!activeDraft) return;
  try {
    await api('PUT', `/api/drafts/${activeDraft}/provider`, { provider });
    setActiveProviderBtn(provider);
    toast(`Switched to ${provider}. Next message uses it.`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Status badge ─────────────────────────────────────────────────────────

async function refreshStatusBadge() {
  if (!activeDraft) return;
  try {
    const { status } = await api('GET', `/api/drafts/${activeDraft}/diff`);
    const el = $('status-badge');
    if (!status.targetExists) {
      el.textContent = '⚠ target deleted';
      el.className = 'status-badge danger';
    } else if (status.dirty) {
      el.textContent = '● unsaved changes';
      el.className = 'status-badge dirty';
    } else {
      el.textContent = '✓ in sync';
      el.className = 'status-badge ok';
    }
  } catch {
    /* ignore */
  }
}

// ── Wire up ───────────────────────────────────────────────────────────────

$('refresh-btn').onclick = refreshPicker;
$('end-btn').onclick = endSession;
$('apply-btn').onclick = applyAndEnd;
$('persona-save-btn').onclick = savePersona;
$('persona-reload-btn').onclick = loadPersona;
$('diff-refresh-btn').onclick = loadDiff;

document.querySelectorAll('#mode-tabs .tab').forEach((btn) => {
  btn.onclick = () => switchMode(btn.dataset.mode);
});
document.querySelectorAll('#provider-toggle .toggle').forEach((btn) => {
  btn.onclick = () => switchProvider(btn.dataset.provider);
});

// Chat input: textarea that auto-resizes with content + Cmd/Ctrl+Enter
// submits. Plain Enter inserts a newline so multi-line messages stay
// natural; the kbd hint label adapts to mac/non-mac.
const isMac = navigator.platform.includes('Mac') || /Mac OS X/.test(navigator.userAgent);
const sendKey = $('send-key');
if (sendKey) sendKey.textContent = isMac ? '⌘↵' : 'Ctrl+↵';

function autosizeChatInput() {
  const ta = $('chat-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 192) + 'px';
}
$('chat-input').addEventListener('input', autosizeChatInput);

async function submitChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !activeDraft) return;
  input.value = '';
  autosizeChatInput();
  logChat('user', text);
  try {
    await api('POST', `/api/drafts/${activeDraft}/messages`, { text });
  } catch (err) {
    logChat('error', err.message);
  }
}

$('chat-form').onsubmit = (ev) => {
  ev.preventDefault();
  void submitChat();
};

$('chat-input').addEventListener('keydown', (ev) => {
  // Cmd+Enter on Mac, Ctrl+Enter elsewhere. Shift+Enter falls through to
  // the default (newline) — never submits with shift held.
  if (ev.key === 'Enter' && !ev.shiftKey && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    void submitChat();
  }
});

refreshPicker();
