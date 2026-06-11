// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  renderSkillRows,
  checkedSkills,
  applyUseAgentToggle,
  syncHiddenModelSelects,
  setBubbleLabels,
} from './simple.js';

const SKILLS = [
  { name: 'image-gen', title: 'Image gen', description: 'Create pictures and logos.', enabled: true },
  { name: 'pdf-reader', title: 'Pdf reader', description: 'Read PDFs.', enabled: false },
];

describe('renderSkillRows / checkedSkills', () => {
  it('renders one checkbox row per skill with the saved checked state', () => {
    const host = document.createElement('div');
    renderSkillRows(host, SKILLS);
    const boxes = host.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    expect(host.textContent).toContain('Image gen');
    expect(checkedSkills(host)).toEqual(['image-gen']);
  });

  it('ⓘ expands the description inline, one open at a time', () => {
    const host = document.createElement('div');
    renderSkillRows(host, SKILLS);
    const infos = host.querySelectorAll('.simple-info-btn');
    const descs = host.querySelectorAll('.simple-skill-desc');
    expect((descs[0] as HTMLElement).hidden).toBe(true);

    (infos[0] as HTMLElement).click();
    expect((descs[0] as HTMLElement).hidden).toBe(false);
    expect((descs[0] as HTMLElement).textContent).toContain('Create pictures');

    (infos[1] as HTMLElement).click(); // opening the second closes the first
    expect((descs[0] as HTMLElement).hidden).toBe(true);
    expect((descs[1] as HTMLElement).hidden).toBe(false);

    (infos[1] as HTMLElement).click(); // clicking again closes it
    expect((descs[1] as HTMLElement).hidden).toBe(true);
  });
});

describe('applyUseAgentToggle', () => {
  function wrapperWithHiddenModeButtons() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <button id="mode-agent"></button>
      <button id="mode-direct"></button>
      <div class="simple-panel-body"></div>
    `;
    return wrapper;
  }

  it('OFF clicks the hidden #mode-direct and grays the panel body', () => {
    const wrapper = wrapperWithHiddenModeButtons();
    let clicked = '';
    wrapper.querySelector('#mode-agent')!.addEventListener('click', () => (clicked = 'agent'));
    wrapper.querySelector('#mode-direct')!.addEventListener('click', () => (clicked = 'direct'));

    applyUseAgentToggle(wrapper, false);
    expect(clicked).toBe('direct');
    expect(wrapper.querySelector('.simple-panel-body')!.classList.contains('simple-disabled')).toBe(true);

    applyUseAgentToggle(wrapper, true);
    expect(clicked).toBe('agent');
    expect(wrapper.querySelector('.simple-panel-body')!.classList.contains('simple-disabled')).toBe(false);
  });
});

// happy-dom does not expose Option as a global constructor; polyfill it so
// the tests below (and syncHiddenModelSelects) can use `new Option(text, val)`.
if (typeof Option === 'undefined') {
  (globalThis as any).Option = function (text?: string, value?: string) {
    const opt = document.createElement('option');
    if (text !== undefined) opt.text = text;
    if (value !== undefined) opt.value = value;
    return opt;
  };
}

describe('syncHiddenModelSelects', () => {
  function wrapperWithHiddenSelects() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<select id="provider-sel"></select><select id="model-sel"></select>`;
    return wrapper;
  }

  it('maps a catalog modelProvider to its PROVIDER_GROUP id and sets both selects', () => {
    const wrapper = wrapperWithHiddenSelects();
    syncHiddenModelSelects(wrapper, 'openai-codex', 'gpt-5.4-mini');
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('openai');
    expect((wrapper.querySelector('#model-sel') as HTMLSelectElement).value).toBe('gpt-5.4-mini');
  });

  it('appends missing options instead of silently failing (template wider than whitelist)', () => {
    const wrapper = wrapperWithHiddenSelects();
    const modelSel = wrapper.querySelector('#model-sel') as HTMLSelectElement;
    modelSel.add(new Option('other-model', 'other-model'));
    syncHiddenModelSelects(wrapper, 'anthropic', 'claude-haiku-4-5');
    expect(modelSel.value).toBe('claude-haiku-4-5');
    expect([...modelSel.options].map((o) => o.value)).toContain('other-model'); // existing options kept
  });

  it('passes unknown providers through as-is (clemson/local style ids)', () => {
    const wrapper = wrapperWithHiddenSelects();
    syncHiddenModelSelects(wrapper, 'clemson', 'some-model');
    expect((wrapper.querySelector('#provider-sel') as HTMLSelectElement).value).toBe('clemson');
  });
});

describe('setBubbleLabels', () => {
  it('writes both CSS custom properties on the wrapper', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'JaneBot', 'gpt-5.4-mini');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 JaneBot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe(
      '"⚡ gpt-5.4-mini — model only (no skills, no personality)"',
    );
  });

  it('escapes double quotes so a name cannot break out of the CSS string', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'Jane"Bot', 'm"x');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 Jane\\"Bot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe('"⚡ m\\"x — model only (no skills, no personality)"');
  });

  it('strips line terminators so a label cannot break the CSS string', () => {
    const wrapper = document.createElement('div');
    setBubbleLabels(wrapper, 'Jane\nBot', 'm\rx');
    expect(wrapper.style.getPropertyValue('--agent-label')).toBe('"🤖 Jane Bot — your agent"');
    expect(wrapper.style.getPropertyValue('--model-label')).toBe('"⚡ m x — model only (no skills, no personality)"');
  });
});
