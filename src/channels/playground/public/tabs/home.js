export function mountHome(el) {
  const { agent, user } = window.__pg || { agent: { name: '?', folder: '?' }, user: { id: '?' } };

  el.innerHTML = `
    <div class="home-layout">
      <section class="home-card">
        <h2>Profile</h2>
        <p class="greeting">Welcome, <strong>${escapeHtml(user.id || 'guest')}</strong>.</p>
        <dl class="home-dl">
          <dt>Current agent</dt>
          <dd><strong>${escapeHtml(agent.name || '?')}</strong> <span class="muted">(${escapeHtml(agent.folder || '?')})</span></dd>
          <dt>Sign-in identity</dt>
          <dd><code>${escapeHtml(user.id || 'anonymous')}</code></dd>
        </dl>
      </section>

      <section class="home-card">
        <h2>Settings</h2>
        <p class="muted">Manage your playground session.</p>
        <div class="home-actions">
          <button id="logout-btn" class="btn">Log out (this session)</button>
          <button id="logout-all-btn" class="btn btn-danger">Log out everywhere</button>
        </div>
      </section>

      <section class="home-card">
        <h2>Session</h2>
        <p class="muted">Session started: <strong id="session-start">${new Date().toLocaleString()}</strong></p>
        <p class="muted">Detailed usage stats (tokens, cost, latency) appear inline under each agent reply in the Chat tab. Session-wide rollups coming in a future iteration.</p>
      </section>

      <section class="home-card">
        <h2>Help</h2>
        <p>This is the agent playground. Use the tabs above to chat with your agent, edit its persona, configure skills, and pick which models it's allowed to use.</p>
        <p>Drafts are auto-tracked — the yellow banner at the top appears when you have unsaved changes. Use <strong>Apply</strong> to commit, <strong>Save to my library</strong> to keep a named snapshot, or <strong>Discard</strong> to revert.</p>
        <p class="muted">Need a fresh login link? Run <code>/playground</code> again on your chat platform.</p>
      </section>
    </div>
  `;

  el.querySelector('#logout-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/me/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* ignore */ }
    window.location.href = '/login';
  });

  el.querySelector('#logout-all-btn').addEventListener('click', async () => {
    if (!confirm('Log out of ALL sessions for this account? Other devices will also need to re-authenticate.')) return;
    try {
      await fetch('/api/me/logout-all', { method: 'POST', credentials: 'same-origin' });
    } catch { /* ignore */ }
    window.location.href = '/login';
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
