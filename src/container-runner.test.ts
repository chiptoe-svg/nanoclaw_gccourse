import { describe, expect, it } from 'vitest';

import { gitAuthorEnvFromMetadata, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('gitAuthorEnvFromMetadata', () => {
  it('emits GIT_AUTHOR + GIT_COMMITTER pairs when name and email are present', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: 'Alice Chen', student_email: 'alice@school.edu' })).toEqual([
      ['GIT_AUTHOR_NAME', 'Alice Chen'],
      ['GIT_AUTHOR_EMAIL', 'alice@school.edu'],
      ['GIT_COMMITTER_NAME', 'Alice Chen'],
      ['GIT_COMMITTER_EMAIL', 'alice@school.edu'],
    ]);
  });

  it('returns empty when student_email is missing (paired-but-no-email or unpaired group)', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: 'Alice Chen' })).toEqual([]);
  });

  it('returns empty when student_name is missing', () => {
    expect(gitAuthorEnvFromMetadata({ student_email: 'alice@school.edu' })).toEqual([]);
  });

  it('returns empty for an entirely empty metadata blob (non-class agent group)', () => {
    expect(gitAuthorEnvFromMetadata({})).toEqual([]);
  });

  it('treats whitespace-only values as missing', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: '   ', student_email: 'alice@school.edu' })).toEqual([]);
  });

  it('trims surrounding whitespace before emitting', () => {
    expect(gitAuthorEnvFromMetadata({ student_name: '  Bob  ', student_email: '  bob@school.edu  ' })).toEqual([
      ['GIT_AUTHOR_NAME', 'Bob'],
      ['GIT_AUTHOR_EMAIL', 'bob@school.edu'],
      ['GIT_COMMITTER_NAME', 'Bob'],
      ['GIT_COMMITTER_EMAIL', 'bob@school.edu'],
    ]);
  });

  it('ignores non-string metadata values defensively', () => {
    expect(
      gitAuthorEnvFromMetadata({ student_name: 42 as unknown as string, student_email: null as unknown as string }),
    ).toEqual([]);
  });
});
