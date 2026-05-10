// Phase 2 home-page bootstrap. Vanilla JS — matches the workbench's
// no-framework choice. Future phases will add settings/dashboard panels
// here; Phase 2 only fetches who-am-I and renders a greeting.
(async () => {
  try {
    const res = await fetch('/api/home/me', { credentials: 'same-origin' });
    if (!res.ok) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json();
    const who = data.userId || 'guest';
    document.getElementById('who').textContent = who;
    document.getElementById('greeting').textContent = `Welcome, ${who}.`;
  } catch (err) {
    console.error('home bootstrap failed', err);
  }
})();
