export function mountHome(el) {
  const { agent, user } = window.__pg || { agent: { name: '?', folder: '?' }, user: { id: '?' } };
  const isOwner = user && user.role === 'owner';

  const params = new URLSearchParams(location.search);
  const googleConnected = params.get('google_connected') === '1';
  const googleDenied = params.get('google_auth_error') === 'denied';
  if (googleConnected || googleDenied) {
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete('google_connected');
    cleaned.searchParams.delete('google_auth_error');
    history.replaceState({}, '', cleaned.pathname + (cleaned.search === '?' ? '' : cleaned.search));
  }

  // Owner-only "Class controls" card. Toggles tabs/providers/auth modes
  // for non-owners. Inserted just below Profile so it's the first thing
  // the instructor sees when they land. Hidden entirely for students.
  const classControlsCard = isOwner
    ? `
      <section class="home-card" id="class-controls-card">
        <h2>Class controls</h2>
        <p class="muted">Choose what students see in the playground. You always see everything.</p>
        <div id="class-controls-body"><p class="muted">Loading…</p></div>
      </section>`
    : '';

  const studentsRosterCard = isOwner
    ? `
      <section class="home-card" id="students-roster-card">
        <h2>Students</h2>
        <div id="students-roster-body"><p class="muted">Loading…</p></div>
      </section>`
    : '';

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
          ${isOwner ? `<dt>Role</dt><dd><strong>owner</strong> <span class="muted">(class instructor)</span></dd>` : ''}
        </dl>
      </section>

      ${classControlsCard}

      ${studentsRosterCard}

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

      <section class="home-card" id="google-card">
        <h2>Google</h2>
        ${googleConnected ? `<p class="muted" id="google-connected-banner">Google account connected.</p>` : ''}
        ${googleDenied ? `<p class="muted" id="google-denied-banner">Connection cancelled.</p>` : ''}
        <div id="google-card-body">
          <p class="muted">Checking status…</p>
        </div>
      </section>

      <section class="home-card" id="usage-card">
        <h2>API credits</h2>
        <div id="usage-card-body"><p class="muted">Loading…</p></div>
      </section>

      <section class="home-card">
        <h2>Session</h2>
        <p class="muted">Session started: <strong id="session-start">${new Date().toLocaleString()}</strong></p>
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
  renderGoogleCard(el.querySelector('#google-card-body'));
  renderUsageCard(el.querySelector('#usage-card-body'), agent.folder);

  if (isOwner) {
    renderClassControlsCard(el.querySelector('#class-controls-body'));
    renderStudentsRosterCard(el.querySelector('#students-roster-body'));
  }
}

async function renderStudentsRosterCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/usage/_/students?providers=codex', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load roster (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (!data.students || data.students.length === 0) {
      body.innerHTML = `<p class="muted">No student agents yet. Add students via the classroom flow.</p>`;
      return;
    }
    const rows = data.students
      .map(
        (s) => `
          <tr>
            <td><code>${escapeHtml(s.agentGroup.folder)}</code></td>
            <td>${escapeHtml(s.agentGroup.name || '?')}</td>
            <td>${fmtUsd(s.thisMonth.costUsd)}</td>
            <td>${fmtUsd(s.total.costUsd)}</td>
            <td>${fmtTokens(s.total.tokensIn)} in · ${fmtTokens(s.total.tokensOut)} out</td>
          </tr>`,
      )
      .join('');
    body.innerHTML = `
      <table class="roster-table">
        <thead><tr><th>Folder</th><th>Agent</th><th>This month</th><th>All-time</th><th>Tokens (lifetime)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted small">Cost computed from token counts × per-model rate. Refresh the page for updated numbers.</p>
    `;
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load roster: ${escapeHtml(String(err))}</p>`;
  }
}

function fmtUsd(n) {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

async function renderUsageCard(body, folder) {
  if (!body || !folder || folder === '?') {
    if (body) body.innerHTML = `<p class="muted">No agent context — usage unavailable.</p>`;
    return;
  }
  try {
    // Class scope: only OpenAI/codex usage counts for billing this term.
    // Strip claude + local rows so the rollup matches what shows up on
    // platform.openai.com → usage. Change ?providers= here when you
    // start charging multiple backends.
    const res = await fetch(`/api/usage/${folder}?providers=codex`, { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load usage (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    const tm = data.thisMonth;
    const tot = data.total;
    const monthRows = tm.byModel.length === 0
      ? `<tr><td colspan="4" class="muted">No usage this month yet.</td></tr>`
      : tm.byModel
          .map(
            (m) => `
            <tr>
              <td><code>${escapeHtml(m.model)}</code> <span class="muted">(${escapeHtml(m.provider)})</span></td>
              <td>${fmtTokens(m.tokensIn)}</td>
              <td>${fmtTokens(m.tokensOut)}</td>
              <td>${fmtUsd(m.costUsd)}</td>
            </tr>`,
          )
          .join('');
    body.innerHTML = `
      <div class="usage-rollup">
        <div class="usage-box">
          <span class="usage-label">This month</span>
          <span class="usage-cost">${fmtUsd(tm.costUsd)}</span>
          <span class="muted">${fmtTokens(tm.tokensIn)} in · ${fmtTokens(tm.tokensOut)} out</span>
        </div>
        <div class="usage-box">
          <span class="usage-label">All-time</span>
          <span class="usage-cost">${fmtUsd(tot.costUsd)}</span>
          <span class="muted">${fmtTokens(tot.tokensIn)} in · ${fmtTokens(tot.tokensOut)} out</span>
        </div>
      </div>
      <table class="usage-table">
        <thead><tr><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
        <tbody>${monthRows}</tbody>
      </table>
      <p class="muted small">Cost = tokens × per-model rate from catalog. Cached-token billing not yet tracked.</p>
    `;
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load usage: ${escapeHtml(String(err))}</p>`;
  }
}

const ALL_TABS = ['home', 'chat', 'persona', 'skills', 'models'];
const ALL_PROVIDERS = ['claude', 'codex', 'local'];
const ALL_AUTH = ['api-key', 'oauth', 'claude-code-oauth'];
const AUTH_LABEL = { 'api-key': 'API key', oauth: 'OAuth (Anthropic Console / OpenAI)', 'claude-code-oauth': 'Claude Code OAuth' };

async function renderClassControlsCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/class-controls', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Couldn't load class controls (${res.status}).</p>`;
      return;
    }
    const cfg = await res.json();
    renderClassControlsForm(body, cfg);
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't load class controls: ${escapeHtml(String(err))}</p>`;
  }
}

function renderClassControlsForm(body, cfg) {
  // v2 shape: cfg.classes.default.{tabsVisibleToStudents, authModesAvailable,
  //   providers: { [id]: { allow, provideDefault, allowByo } } }
  const DEFAULT_CLASS_ID = 'default';
  const cls = (cfg.classes && cfg.classes[DEFAULT_CLASS_ID]) || {
    tabsVisibleToStudents: [], authModesAvailable: [], providers: {},
  };
  const providerAllowed = (p) => !!(cls.providers && cls.providers[p] && cls.providers[p].allow);

  const tabsChecks = ALL_TABS.map((t) => `
    <label class="cc-check"><input type="checkbox" data-cc-tab="${t}" ${cls.tabsVisibleToStudents.includes(t) ? 'checked' : ''}> ${t}</label>
  `).join('');
  const providersChecks = ALL_PROVIDERS.map((p) => `
    <label class="cc-check"><input type="checkbox" data-cc-provider="${p}" ${providerAllowed(p) ? 'checked' : ''}> ${p}</label>
  `).join('');
  const authChecks = ALL_AUTH.map((a) => `
    <label class="cc-check"><input type="checkbox" data-cc-auth="${a}" ${cls.authModesAvailable.includes(a) ? 'checked' : ''}> ${escapeHtml(AUTH_LABEL[a])}</label>
  `).join('');

  body.innerHTML = `
    <div class="cc-group">
      <h3>Tabs visible to students</h3>
      <div class="cc-row">${tabsChecks}</div>
    </div>
    <div class="cc-group">
      <h3>Providers available</h3>
      <div class="cc-row">${providersChecks}</div>
    </div>
    <div class="cc-group">
      <h3>Auth modes available</h3>
      <div class="cc-row">${authChecks}</div>
    </div>
    <div class="home-actions">
      <button class="btn btn-primary" id="cc-save">Save class controls</button>
      <span class="muted" id="cc-status"></span>
    </div>
  `;

  body.querySelector('#cc-save').addEventListener('click', async () => {
    // Reconstruct providers map from checkbox state. Preserve existing
    // provideDefault/allowByo flags from the loaded cfg so the toggle here
    // controls only `allow` — Task 11 will add UI for the finer-grained
    // per-provider flags.
    const checkedProviderIds = new Set(
      [...body.querySelectorAll('[data-cc-provider]')].filter((i) => i.checked).map((i) => i.dataset.ccProvider),
    );
    const providers = {};
    for (const p of ALL_PROVIDERS) {
      const existing = (cls.providers && cls.providers[p]) || { provideDefault: false, allowByo: false };
      providers[p] = {
        allow: checkedProviderIds.has(p),
        provideDefault: !!existing.provideDefault,
        allowByo: !!existing.allowByo,
      };
    }
    const next = {
      classes: {
        [DEFAULT_CLASS_ID]: {
          tabsVisibleToStudents: [...body.querySelectorAll('[data-cc-tab]')].filter((i) => i.checked).map((i) => i.dataset.ccTab),
          authModesAvailable: [...body.querySelectorAll('[data-cc-auth]')].filter((i) => i.checked).map((i) => i.dataset.ccAuth),
          providers,
        },
      },
    };
    const status = body.querySelector('#cc-status');
    status.textContent = 'Saving…';
    try {
      const res = await fetch('/api/class-controls', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        status.textContent = `Save failed: ${err.error || res.status}`;
        return;
      }
      status.textContent = 'Saved. Students will see the new settings on their next page load.';
    } catch (err) {
      status.textContent = `Save failed: ${String(err)}`;
    }
  });
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

async function renderGoogleCard(body) {
  if (!body) return;
  try {
    const res = await fetch('/api/me/google', { credentials: 'same-origin' });
    if (!res.ok) {
      body.innerHTML = `<p class="muted">Google connection status unavailable (${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (data.connected) {
      body.innerHTML = `
        <p>✅ Connected as <code>${escapeHtml(data.email || '?')}</code>.</p>
        <p class="muted">Your agent's Drive / Sheets / Slides tools now use YOUR Google Drive instead of the instructor's shared one. Disconnect to revert to the class-shared Drive.</p>
        <div class="home-actions">
          <button id="google-disconnect-btn" class="btn btn-danger">Disconnect</button>
        </div>
      `;
      body.querySelector('#google-disconnect-btn').addEventListener('click', async () => {
        if (
          !confirm(
            'Disconnect your Google account? Your agent will fall back to the class-shared Drive for new operations. Existing Docs/Sheets in YOUR Drive remain in YOUR Drive — only future writes change destination.',
          )
        )
          return;
        await fetch('/api/me/google/disconnect', { method: 'POST', credentials: 'same-origin' });
        renderGoogleCard(body);
      });
      return;
    }
    body.innerHTML = `
      <p class="muted">Connect your Google account so your agent operates against YOUR Drive (not the instructor's). Optional — until you connect, Drive tools work via the shared class-Drive (Mode A). Gmail and Calendar tools (coming soon) will require connection.</p>
      <div class="home-actions">
        <a class="btn" href="/google-auth/start">Connect Google</a>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<p class="muted">Couldn't reach the Google status endpoint: ${escapeHtml(String(err))}</p>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
