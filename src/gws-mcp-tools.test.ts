/**
 * Integration tests for gws-mcp-tools.ts.
 *
 * Tier B: principal field on Drive success results.
 * Tier C: Gmail search, read-thread, send-draft — including connect_required
 *         gating when the student hasn't connected their personal Google account.
 *
 * Strategy: mock ./gws-token.js so getGoogleAccessTokenForAgentGroup
 * returns a controlled { token, principal } without hitting disk or the
 * network; mock @googleapis/* so no real HTTP is made. Then invoke each
 * SUT function and assert the expected shape.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── hoisted mock state ────────────────────────────────────────────────────────

const {
  mockGetGoogleAccessTokenForAgentGroup,
  mockFilesExport,
  mockMessagesListFn,
  mockMessagesGetFn,
  mockThreadsGetFn,
  mockDraftsCreateFn,
} = vi.hoisted(() => ({
  mockGetGoogleAccessTokenForAgentGroup: vi.fn(),
  mockFilesExport: vi.fn(),
  mockMessagesListFn: vi.fn(),
  mockMessagesGetFn: vi.fn(),
  mockThreadsGetFn: vi.fn(),
  mockDraftsCreateFn: vi.fn(),
}));

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./gws-token.js', () => ({
  getGoogleAccessTokenForAgentGroup: mockGetGoogleAccessTokenForAgentGroup,
}));

// Minimal @googleapis/drive stub — OAuth2 is shared across all googleapis
// clients; the real constructable class is needed so `new gAuth.OAuth2()` works.
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
// not called by the tools under test here — stub to avoid resolution errors.
vi.mock('@googleapis/sheets', () => ({
  sheets: vi.fn(() => ({ spreadsheets: { values: { get: vi.fn(), update: vi.fn() } } })),
}));

vi.mock('@googleapis/slides', () => ({
  slides: vi.fn(() => ({ presentations: { batchUpdate: vi.fn() } })),
}));

vi.mock('@googleapis/gmail', () => {
  return {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesListFn,
          get: mockMessagesGetFn,
        },
        threads: {
          get: mockThreadsGetFn,
        },
        drafts: {
          create: mockDraftsCreateFn,
        },
      },
    })),
  };
});

// ── import SUT after mocks ────────────────────────────────────────────────────

import { driveDocReadAsMarkdown, gmailSearch, gmailReadThread, gmailSendDraft } from './gws-mcp-tools.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = { agentGroupId: 'ag_test' };
const FAKE_MARKDOWN = '# Hello\n\nWorld';

/** Wire mockFilesExport to return a successful export response. */
function stubDriveExportOk() {
  mockFilesExport.mockResolvedValue({ data: FAKE_MARKDOWN });
}

/** Build a base64url-encoded body the same way Gmail encodes it. */
function encodeBase64Url(text: string): string {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Tier B: Drive tests ───────────────────────────────────────────────────────

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

// ── Tier C: Gmail tests ───────────────────────────────────────────────────────

describe('gmailSearch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — returns messages with principal', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });
    mockMessagesListFn.mockResolvedValue({ data: { messages: [{ id: 'msg1' }, { id: 'msg2' }] } });
    mockMessagesGetFn.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({
        data: {
          id,
          threadId: `thread_${id}`,
          snippet: `snippet for ${id}`,
          payload: {
            headers: [
              { name: 'Subject', value: `Subject ${id}` },
              { name: 'From', value: `sender@example.com` },
              { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
            ],
          },
        },
      }),
    );

    const result = await gmailSearch(CTX, { query: 'is:unread' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('self');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      id: 'msg1',
      threadId: 'thread_msg1',
      subject: 'Subject msg1',
      from: 'sender@example.com',
    });
  });

  it('returns connect_required when resolver returns null (student not connected)', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await gmailSearch(CTX, { query: 'test' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });

  it('respects max_results default and cap', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockMessagesListFn.mockResolvedValue({ data: { messages: [] } });

    await gmailSearch(CTX, { query: 'foo' });
    expect(mockMessagesListFn).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 20 }));

    await gmailSearch(CTX, { query: 'foo', max_results: 100 });
    expect(mockMessagesListFn).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 50 }));
  });
});

describe('gmailReadThread', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — decodes base64url plain-text body correctly', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });

    const plainBody = 'Hello, World!\nThis is a test email.';
    const encodedBody = encodeBase64Url(plainBody);

    mockThreadsGetFn.mockResolvedValue({
      data: {
        id: 'thread123',
        messages: [
          {
            id: 'msg123',
            threadId: 'thread123',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: 'alice@example.com' },
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Test subject' },
                { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
              ],
              body: { data: encodedBody },
            },
          },
        ],
      },
    });

    const result = await gmailReadThread(CTX, { thread_id: 'thread123' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toBe('self');
    expect(result.threadId).toBe('thread123');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].body).toBe(plainBody);
    expect(result.messages[0].from).toBe('alice@example.com');
    expect(result.messages[0].subject).toBe('Test subject');
  });

  it('prefers plain text over HTML in a multipart message', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });

    const plainText = 'Plain version';
    const htmlText = '<p>HTML version</p>';

    mockThreadsGetFn.mockResolvedValue({
      data: {
        id: 'thread_mp',
        messages: [
          {
            id: 'msg_mp',
            threadId: 'thread_mp',
            payload: {
              mimeType: 'multipart/alternative',
              headers: [
                { name: 'From', value: 'x@y.com' },
                { name: 'To', value: 'z@w.com' },
                { name: 'Subject', value: 'Multipart' },
                { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
              ],
              parts: [
                { mimeType: 'text/plain', body: { data: encodeBase64Url(plainText) } },
                { mimeType: 'text/html', body: { data: encodeBase64Url(htmlText) } },
              ],
            },
          },
        ],
      },
    });

    const result = await gmailReadThread(CTX, { thread_id: 'thread_mp' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messages[0].body).toBe(plainText);
  });

  it('falls back to stripped HTML when only HTML is present', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });

    const htmlText = '<p>Hello <strong>world</strong></p>';

    mockThreadsGetFn.mockResolvedValue({
      data: {
        id: 'thread_html',
        messages: [
          {
            id: 'msg_html',
            threadId: 'thread_html',
            payload: {
              mimeType: 'text/html',
              headers: [
                { name: 'From', value: 'a@b.com' },
                { name: 'To', value: 'c@d.com' },
                { name: 'Subject', value: 'HTML only' },
                { name: 'Date', value: 'Thu, 15 May 2026 10:00:00 +0000' },
              ],
              body: { data: encodeBase64Url(htmlText) },
            },
          },
        ],
      },
    });

    const result = await gmailReadThread(CTX, { thread_id: 'thread_html' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // HTML tags stripped, content preserved
    expect(result.messages[0].body).toContain('Hello');
    expect(result.messages[0].body).toContain('world');
    expect(result.messages[0].body).not.toContain('<p>');
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await gmailReadThread(CTX, { thread_id: 'thread_x' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });
});

describe('gmailSendDraft', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('happy path — includes composeUrl and returns draftId/messageId', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'student-tok', principal: 'self' });
    mockDraftsCreateFn.mockResolvedValue({
      data: {
        id: 'draft_abc',
        message: { id: 'msg_xyz', threadId: 'thread_xyz' },
      },
    });

    const result = await gmailSendDraft(CTX, {
      to: 'recipient@example.com',
      subject: 'Hello',
      body: 'This is the body.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draftId).toBe('draft_abc');
    expect(result.messageId).toBe('msg_xyz');
    expect(result.threadId).toBe('thread_xyz');
    expect(result.composeUrl).toBe('https://mail.google.com/mail/u/0/#drafts/msg_xyz');
    expect(result.principal).toBe('self');
  });

  it('happy path — passes threadId in requestBody when in_reply_to_thread_id set', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockDraftsCreateFn.mockResolvedValue({
      data: {
        id: 'draft_reply',
        message: { id: 'msg_reply', threadId: 'thread_orig' },
      },
    });

    await gmailSendDraft(CTX, {
      to: 'a@b.com',
      subject: 'Re: something',
      body: 'Reply body',
      in_reply_to_thread_id: 'thread_orig',
    });

    const callArg = mockDraftsCreateFn.mock.calls[0][0] as {
      requestBody: { message: { threadId?: string } };
    };
    expect(callArg.requestBody.message.threadId).toBe('thread_orig');
  });

  it('returns connect_required when resolver returns null', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue(null);

    const result = await gmailSendDraft(CTX, {
      to: 'x@y.com',
      subject: 'Test',
      body: 'Body',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_required');
    expect(result.status).toBe(403);
  });

  it('handles array `to` recipients', async () => {
    mockGetGoogleAccessTokenForAgentGroup.mockResolvedValue({ token: 'tok', principal: 'self' });
    mockDraftsCreateFn.mockResolvedValue({
      data: {
        id: 'draft_multi',
        message: { id: 'msg_multi', threadId: '' },
      },
    });

    const result = await gmailSendDraft(CTX, {
      to: ['a@example.com', 'b@example.com'],
      subject: 'Multi',
      body: 'Body',
    });

    expect(result.ok).toBe(true);
    // The raw message should have been built — check the draft was created
    expect(mockDraftsCreateFn).toHaveBeenCalledTimes(1);
  });
});
