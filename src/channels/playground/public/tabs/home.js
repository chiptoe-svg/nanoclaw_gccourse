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

      <section class="home-card" id="telegram-card">
        <h2>Telegram</h2>
        <div id="telegram-card-body">
          <p class="muted">Checking status…</p>
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

  renderTelegramCard(el.querySelector('#telegram-card-body'));
}

async function renderTelegramCard(body) {
  try {
    const res = await fetch('/api/me/telegram', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Telegram pairing not available (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (data.paired) {
      body.innerHTML = `
        <p>✅ Connected as <code>${escapeHtml(data.telegramHandle || '?')}</code>${
          data.botUsername ? ` via <strong>@${escapeHtml(data.botUsername)}</strong>` : ''
        }.</p>
        <p class="muted">DM the bot from your own Telegram account to chat with your class agent — same agent as on the web.</p>
      `;
      return;
    }
    if (!data.botUsername) {
      body.innerHTML = `
        <p>The instructor hasn't configured the Telegram bot yet, so pairing is unavailable.</p>
      `;
      return;
    }
    body.innerHTML = `
      <p class="muted">Link your Telegram account so you can chat with your class agent from your phone.</p>
      <div class="home-actions">
        <button id="telegram-pair-btn" class="btn">Connect Telegram</button>
        <button id="telegram-refresh-btn" class="btn">Refresh status</button>
      </div>
      <div id="telegram-pair-instructions" hidden></div>
    `;
    body.querySelector('#telegram-pair-btn').addEventListener('click', () =>
      issueAndShowCode(body, data.botUsername),
    );
    body.querySelector('#telegram-refresh-btn').addEventListener('click', () => renderTelegramCard(body));
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't reach the pairing endpoint: ${escapeHtml(String(err))}</p>`;
  }
}

async function issueAndShowCode(body, botUsername) {
  const target = body.querySelector('#telegram-pair-instructions');
  target.hidden = false;
  target.innerHTML = `<p class="muted">Issuing a fresh code…</p>`;
  try {
    const res = await fetch('/api/me/telegram/pair-code', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) {
      target.innerHTML = `<p class="muted">Couldn't mint a code (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    const code = escapeHtml(data.code);
    const bot = escapeHtml(botUsername);
    const expiresMin = Math.max(1, Math.round((data.expiresAt - Date.now()) / 60000));
    target.innerHTML = `
      <ol>
        <li>Open Telegram and find <a href="https://t.me/${bot}" target="_blank" rel="noopener"><strong>@${bot}</strong></a>.</li>
        <li>Send this exact message: <code>/pair-class ${code}</code></li>
        <li>The bot will reply <em>"Paired!"</em> — then come back here and click <strong>Refresh status</strong>.</li>
      </ol>
      <p class="muted">Code expires in ~${expiresMin} min.</p>
    `;
  } catch (err) {
    target.innerHTML = `<p class="muted">Couldn't mint a code: ${escapeHtml(String(err))}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
