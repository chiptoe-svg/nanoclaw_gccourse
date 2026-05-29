import { describe, it, expect } from 'vitest';
import { parseSections } from './sections.js';

describe('parseSections', () => {
  it('parses an anthropic request into system / tools / messages', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        system: 'You are helpful.',
        tools: [{ name: 'bash', description: 'run shell' }],
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      }),
    );
    const s = parseSections('anthropic', body);
    expect(s.system).toBeGreaterThan(0);
    expect(s.tools).toBeGreaterThan(0);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].bytes).toBeGreaterThan(0);
  });

  it('parses an openai request into system+instructions / tools / messages', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-5.4',
        instructions: 'You are helpful.',
        tools: [{ type: 'function', function: { name: 'bash' } }],
        messages: [
          { role: 'system', content: 'system msg' },
          { role: 'user', content: 'hello' },
        ],
      }),
    );
    const s = parseSections('openai', body);
    expect(s.system).toBeGreaterThan(0);
    expect(s.tools).toBeGreaterThan(0);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].role).toBe('user');
  });

  it('returns empty sections for an unparseable body', () => {
    const body = Buffer.from('not json');
    const s = parseSections('anthropic', body);
    expect(s.system).toBe(0);
    expect(s.tools).toBe(0);
    expect(s.messages).toEqual([]);
    expect(s.unparseable).toBe(true);
  });

  it('treats clemson, openai-platform, and omlx routes as openai-shaped', () => {
    const body = Buffer.from(
      JSON.stringify({
        model: 'gpt-oss-120b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    for (const route of ['openai-platform', 'omlx', 'clemson']) {
      const s = parseSections(route, body);
      expect(s.unparseable).toBe(false);
      expect(s.messages).toHaveLength(1);
    }
  });

  it('records total bytes', () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
    const s = parseSections('openai', body);
    expect(s.totalBytes).toBe(body.length);
  });
});
