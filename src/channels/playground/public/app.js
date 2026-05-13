import { mountChat } from './tabs/chat.js';
import { mountPersona } from './tabs/persona.js';
import { mountSkills } from './tabs/skills.js';
import { mountModels } from './tabs/models.js';
import { initDraftBanner } from './draft-banner.js';

const TABS = ['chat', 'persona', 'skills', 'models'];
const mounters = { chat: mountChat, persona: mountPersona, skills: mountSkills, models: mountModels };
const mounted = {};

function showTab(name) {
  for (const t of TABS) {
    document.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === name);
    document.getElementById(`tab-${t}`).hidden = t !== name;
  }
  if (!mounted[name]) {
    mounters[name](document.getElementById(`tab-${name}`));
    mounted[name] = true;
  }
}

async function init() {
  // Resolve the agent group this user is assigned to (or the first non-draft
  // group as a fallback for operators not formally membered).
  let agent = { id: '?', name: '(no agent)', folder: '?' };
  let user = { id: '?', email: undefined };
  try {
    const r = await fetch('/api/me/agent', { credentials: 'same-origin' });
    if (r.ok) {
      const data = await r.json();
      agent = data.agent;
      user = data.user;
    }
  } catch {
    /* /api/me/agent not yet wired or user not signed in */
  }
  window.__pg = { agent, user };
  document.getElementById('active-agent-name').textContent = agent.name;
  document.getElementById('who').textContent = user.email || user.id;

  initDraftBanner();

  for (const t of TABS) {
    document.querySelector(`[data-tab="${t}"]`).addEventListener('click', () => showTab(t));
  }
  showTab('chat');
}

init();
