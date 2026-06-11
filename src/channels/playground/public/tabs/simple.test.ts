// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderSkillRows, checkedSkills, applyUseAgentToggle } from './simple.js';

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
