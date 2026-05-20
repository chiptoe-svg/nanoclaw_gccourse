import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('custom-skills', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-skills-'));
    // custom-skills.ts only consumes GROUPS_DIR from config.
    vi.doMock('../../config.js', () => ({ GROUPS_DIR: tmp }));
  });

  afterEach(() => {
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('write → list → read round-trips', async () => {
    const { writeCustomSkill, listCustomSkills, readCustomSkill } = await import('./custom-skills.js');
    writeCustomSkill('grp', 'my-skill', '---\nname: my-skill\ndescription: Does a thing.\n---\n# Body');
    expect(listCustomSkills('grp')).toEqual([{ name: 'my-skill', description: 'Does a thing.' }]);
    expect(readCustomSkill('grp', 'my-skill')).toContain('# Body');
  });

  it('listCustomSkills returns [] for a group with none', async () => {
    const { listCustomSkills } = await import('./custom-skills.js');
    expect(listCustomSkills('empty-grp')).toEqual([]);
  });

  it('rejects invalid skill names on write (traversal, dotfiles)', async () => {
    const { writeCustomSkill } = await import('./custom-skills.js');
    expect(() => writeCustomSkill('grp', '../escape', 'x')).toThrow();
    expect(() => writeCustomSkill('grp', '.hidden', 'x')).toThrow();
  });

  it('readCustomSkill returns undefined for a bad name or missing skill', async () => {
    const { readCustomSkill } = await import('./custom-skills.js');
    expect(readCustomSkill('grp', 'nope')).toBeUndefined();
    expect(readCustomSkill('grp', '../etc')).toBeUndefined();
  });

  it('delete removes the skill; returns false when absent', async () => {
    const { writeCustomSkill, deleteCustomSkill, customSkillExists } = await import('./custom-skills.js');
    writeCustomSkill('grp', 'temp', 'x');
    expect(customSkillExists('grp', 'temp')).toBe(true);
    expect(deleteCustomSkill('grp', 'temp')).toBe(true);
    expect(customSkillExists('grp', 'temp')).toBe(false);
    expect(deleteCustomSkill('grp', 'temp')).toBe(false);
  });
});
