/**
 * Integration tests for gws-mcp-tools.ts — Tier B: principal field on
 * success results.
 *
 * Strategy: mock ./gws-token.js so getGoogleAccessTokenForAgentGroup
 * returns a controlled { token, principal } without hitting disk or
 * the network; mock @googleapis/drive so files.export returns a stub
 * markdown body without making real HTTP calls. Then invoke
 * driveDocReadAsMarkdown and assert the principal field is echoed
 * through unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── hoisted mock state ────────────────────────────────────────────────────────

const { mockGetGoogleAccessTokenForAgentGroup, mockFilesExport } = vi.hoisted(() => ({
  mockGetGoogleAccessTokenForAgentGroup: vi.fn(),
  mockFilesExport: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./gws-token.js', () => ({
  getGoogleAccessTokenForAgentGroup: mockGetGoogleAccessTokenForAgentGroup,
}));

// Minimal @googleapis/drive stub — only files.export is needed for this test.
// OAuth2 must be a real constructable class whose instances have setCredentials.
vi.mock('@googleapis/drive', () => {
  class FakeOAuth2 {
    setCredentials(_creds: unknown) {}
  }
  return {
    drive: vi.fn(() => ({
      files: {
        export: mockFilesExport,
      },
    })),
    auth: { OAuth2: FakeOAuth2 },
  };
});

// @googleapis/sheets and @googleapis/slides are imported at module level but
// not called by driveDocReadAsMarkdown — stub them to avoid resolution errors.
vi.mock('@googleapis/sheets', () => ({
  sheets: vi.fn(() => ({ spreadsheets: { values: { get: vi.fn(), update: vi.fn() } } })),
}));

vi.mock('@googleapis/slides', () => ({
  slides: vi.fn(() => ({ presentations: { batchUpdate: vi.fn() } })),
}));

// ── import SUT after mocks ────────────────────────────────────────────────────

import { driveDocReadAsMarkdown } from './gws-mcp-tools.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = { agentGroupId: 'ag_test' };
const FAKE_MARKDOWN = '# Hello\n\nWorld';

/** Wire mockFilesExport to return a successful export response. */
function stubDriveExportOk() {
  mockFilesExport.mockResolvedValue({ data: FAKE_MARKDOWN });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('driveDocReadAsMarkdown — principal field', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    stubDriveExportOk();
  });

  it('carries principal: "self" when resolver returns a per-student token', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'fake-student-token', principal: 'self' });

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_abc' });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TypeScript
    expect(result.principal).toBe('self');
    expect(result.fileId).toBe('doc_abc');
    expect(result.markdown).toBe(FAKE_MARKDOWN);
  });

  it('carries principal: "instructor-fallback" when resolver falls back to the instructor token', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({
      token: 'fake-instructor-token',
      principal: 'instructor-fallback',
    });

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_xyz' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('instructor-fallback');
    expect(result.fileId).toBe('doc_xyz');
  });

  it('returns ok:false (no principal) when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await driveDocReadAsMarkdown(CTX, { file_id: 'doc_nope' });

    expect(result.ok).toBe(false);
    expect('principal' in result).toBe(false);
  });
});
