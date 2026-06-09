import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-default-participant',
    GROUPS_DIR: '/tmp/nanoclaw-test-default-participant/groups',
  };
});

import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { _resetScenariosForTest, registerScenario } from './scenarios/registry.js';
import { ensureTemplateAgent, saveDefaultFromTemplate, TEMPLATE_FOLDER } from './default-participant.js';
import { slotExists, readSlotConfig, slotDir } from './default-participant-slot.js';

const TMP = '/tmp/nanoclaw-test-default-participant';
const GROUPS = path.join(TMP, 'groups');

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  _resetScenariosForTest();
  registerScenario({
    name: 'stub',
    roles: { user: { label: 'P', permission: 'member', persona: (n) => `persona for ${n}`, greeting: (n) => n } },
    roleForFolder: (f) => (f.startsWith('user_') ? 'user' : null),
    memberName: () => null,
    folderPrefix: { user: 'user_' },
  });
});
afterEach(() => {
  _resetScenariosForTest();
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('default participant template', () => {
  it('ensureTemplateAgent creates the flagged template group once (idempotent)', () => {
    const a = ensureTemplateAgent();
    expect(getAgentGroupByFolder(TEMPLATE_FOLDER)?.id).toBe(a.id);
    expect(a.folder).toBe(TEMPLATE_FOLDER);
    const b = ensureTemplateAgent();
    expect(b.id).toBe(a.id); // idempotent, no duplicate
    // persona seeded
    expect(fs.readFileSync(path.join(GROUPS, TEMPLATE_FOLDER, 'CLAUDE.local.md'), 'utf8')).toContain(
      'persona for Participant',
    );
  });

  it('saveDefaultFromTemplate snapshots files + container config into the slot', () => {
    const ag = ensureTemplateAgent();
    fs.writeFileSync(path.join(GROUPS, TEMPLATE_FOLDER, 'CLAUDE.local.md'), '# custom persona\n');
    updateContainerConfigScalars(ag.id, { model: 'gpt-5.5' });
    saveDefaultFromTemplate('owner:test');
    expect(slotExists()).toBe(true);
    expect(fs.readFileSync(path.join(slotDir(), 'CLAUDE.local.md'), 'utf8')).toBe('# custom persona\n');
    expect(readSlotConfig()?.model).toBe('gpt-5.5');
  });
});
