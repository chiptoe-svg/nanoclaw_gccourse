/**
 * One-shot smoke test for Phase X.7 — verifies the URL that a student's
 * browser would open when they click Connect on the Providers card.
 *
 * Mirrors Task 14 step 6 (the "what's the authorize URL look like?" check)
 * without needing a live dev server, PIN sign-in flow, or browser.
 *
 * Usage: pnpm exec tsx scripts/x7-url-smoke.ts
 */
import { handleProviderAuthStart } from '../src/channels/playground/api/provider-auth.js';
import '../src/providers/claude-spec.js';
import '../src/providers/codex-spec.js';

const PROVIDERS = ['claude', 'codex'] as const;

let failed = 0;

for (const providerId of PROVIDERS) {
  console.log(`\n=== ${providerId} ===`);
  const result = handleProviderAuthStart(providerId, { userId: 'smoke@test' });
  if (result.status !== 200) {
    console.error(`FAIL: start returned status ${result.status}`, result.body);
    failed++;
    continue;
  }
  const body = result.body as { authorizeUrl: string; state: string; instructions: string; displayName: string };
  console.log('displayName:', body.displayName);
  console.log('state.length:', body.state.length, body.state.length >= 32 ? '✓' : '✗ (expected >=32)');

  const url = new URL(body.authorizeUrl);
  console.log('origin:', url.origin);
  console.log('pathname:', url.pathname);
  console.log('query params:');
  for (const [k, v] of url.searchParams) {
    console.log(`  ${k} =`, k === 'scope' ? v : v.length > 60 ? v.slice(0, 60) + '…' : v);
  }

  // Per-provider expected shape
  const expectedHost = providerId === 'claude' ? 'claude.com' : 'auth.openai.com';
  const expectedClientPrefix = providerId === 'claude' ? '9d1c250a' : 'app_';
  const expectedRedirectHost = providerId === 'claude' ? 'platform.claude.com' : 'localhost:1455';

  const checks = [
    [`host = ${expectedHost}`, url.hostname === expectedHost],
    [`client_id starts with "${expectedClientPrefix}"`, url.searchParams.get('client_id')?.startsWith(expectedClientPrefix)],
    [`response_type = code`, url.searchParams.get('response_type') === 'code'],
    [`code_challenge present`, !!url.searchParams.get('code_challenge')],
    [`code_challenge_method = S256`, url.searchParams.get('code_challenge_method') === 'S256'],
    [`state in URL = state in response`, url.searchParams.get('state') === body.state],
    [`redirect_uri host = ${expectedRedirectHost}`, url.searchParams.get('redirect_uri')?.includes(expectedRedirectHost)],
    [`scope non-empty`, (url.searchParams.get('scope') || '').length > 0],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failed++;
  }
  console.log('\ninstructions preview:');
  console.log(body.instructions.split('\n').slice(0, 4).map(l => '  > ' + l).join('\n'));
}

console.log('\n' + '='.repeat(50));
console.log(failed === 0 ? 'SMOKE PASS — all URL checks green for both providers' : `SMOKE FAIL — ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
