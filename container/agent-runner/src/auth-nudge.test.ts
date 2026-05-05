/**
 * Pure-logic tests for auth-nudge.
 *
 * The full requestReauth path writes to the session outbound DB (via
 * writeMessageOut) which requires a session DB context — tested
 * end-to-end as part of Phase 7. These unit tests cover the public
 * detection regex only, plus the test hook for debouncing.
 */
import { describe, expect, it } from 'bun:test';
import { _resetDebounceForTest, looksLikeAuthFailure } from './auth-nudge.js';

describe('looksLikeAuthFailure', () => {
  it('matches an OAuth invalid_grant error', () => {
    expect(looksLikeAuthFailure('OAuth error: invalid_grant: refresh_token expired')).toBe(true);
  });

  it('matches a 401 Unauthorized response', () => {
    expect(looksLikeAuthFailure('HTTP 401 Unauthorized — token rejected')).toBe(true);
  });

  it('matches "authentication failed" in plain English', () => {
    expect(looksLikeAuthFailure('authentication failed: please sign in again')).toBe(true);
  });

  it('matches "token expired"', () => {
    expect(looksLikeAuthFailure('Error: access token has expired and refresh token expired')).toBe(true);
  });

  it('matches "invalid token"', () => {
    expect(looksLikeAuthFailure('upstream returned invalid token')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(looksLikeAuthFailure('rate limit exceeded')).toBe(false);
    expect(looksLikeAuthFailure('network unreachable')).toBe(false);
    expect(looksLikeAuthFailure('500 internal server error')).toBe(false);
    expect(looksLikeAuthFailure('the model returned an empty response')).toBe(false);
  });

  it('does not match "auth" as a substring of unrelated words', () => {
    // The \b boundary should keep this from matching "Author", "authentic", etc.
    // We're a little loose; "auth required" matches but "Author Smith" doesn't.
    expect(looksLikeAuthFailure('Author Smith wrote the docs')).toBe(false);
    // But auth-required strings legitimately tagged should still match.
    expect(looksLikeAuthFailure('auth required to call this endpoint')).toBe(true);
  });
});

describe('_resetDebounceForTest', () => {
  it('exists and is callable', () => {
    expect(() => _resetDebounceForTest()).not.toThrow();
  });
});
