// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { previewForToolArgs, previewForToolResult, classifyToolResult, traceResultText } from './chat.js';

describe('traceResultText', () => {
  it('extracts text from a string, an AgentToolResult content array, and falls back to JSON', () => {
    expect(traceResultText('hello')).toBe('hello');
    expect(
      traceResultText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a b');
    expect(traceResultText({ foo: 1 })).toContain('foo');
    expect(traceResultText(null)).toBe('');
  });
  it('handles bare text-block arrays and ignores non-string text values', () => {
    expect(
      traceResultText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a b');
    expect(traceResultText([{ text: 5 }])).toBe(JSON.stringify([{ text: 5 }]));
  });
});

describe('classifyToolResult', () => {
  it('prefers the native isError flag', () => {
    expect(classifyToolResult({ isError: true, result: 'whatever' })).toBe('error');
    expect(classifyToolResult({ isError: false, result: 'Fetch failed: x' })).toBe('ok');
  });
  it('falls back to error-string prefixes when isError is absent', () => {
    expect(classifyToolResult({ result: { content: [{ type: 'text', text: 'Fetch failed: HTTP 500' }] } })).toBe(
      'error',
    );
    expect(classifyToolResult({ result: 'blocked by egress policy: internal address 10.0.0.1' })).toBe('error');
    expect(classifyToolResult({ result: 'Web search failed: 422' })).toBe('error');
    expect(classifyToolResult({ result: 'Search results for "x": ...' })).toBe('ok');
  });
  it('returns ok for null/empty events', () => {
    expect(classifyToolResult(null)).toBe('ok');
    expect(classifyToolResult({})).toBe('ok');
  });
  it('does not false-positive on Error-free text (Fix 1)', () => {
    expect(classifyToolResult({ result: 'Error-free approaches to X' })).toBe('ok');
    expect(classifyToolResult({ result: 'Error: something broke' })).toBe('error');
  });
});

describe('previewForToolArgs', () => {
  it('surfaces the meaningful field per tool, defers to the generic formatter otherwise', () => {
    expect(previewForToolArgs('web_search', { query: 'weather in paris' })).toContain('weather in paris');
    expect(previewForToolArgs('fetch_url', { url: 'https://example.com/x' })).toContain('https://example.com/x');
    expect(previewForToolArgs('bash', { cmd: 'ls -la' })).toContain('ls -la');
    expect(previewForToolArgs('mystery', { query: 'q' })).toContain('q');
  });
  it('handles the real bash param name `command`', () => {
    expect(previewForToolArgs('bash', { command: 'ls -la' })).toContain('ls -la');
  });
});

describe('previewForToolResult', () => {
  it('shows the first error line when status is error', () => {
    expect(
      previewForToolResult('fetch_url', { content: [{ type: 'text', text: 'Fetch failed: HTTP 500\nmore' }] }, 'error'),
    ).toContain('Fetch failed: HTTP 500');
  });
  it('shows a result count for web_search successes when derivable', () => {
    const r = { content: [{ type: 'text', text: 'Search results for "x":\n\n1. A\n2. B\n3. C' }] };
    expect(previewForToolResult('web_search', r, 'ok')).toMatch(/\b3 results\b/);
  });
  it('falls back to the generic preview for unknown tools', () => {
    expect(previewForToolResult('mystery', 'plain text result', 'ok')).toContain('plain text');
  });
});
