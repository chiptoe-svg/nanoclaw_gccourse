/**
 * Targeted unit test for the parseRosterCsv helper. The rest of
 * class-skeleton.ts is procedural provisioning glue (fs writes,
 * createPairing calls); covering the CSV parser is enough to give the
 * --roster flag a green safety net.
 */
import { describe, expect, it } from 'vitest';

import { parseRosterCsv } from './class-skeleton.js';

describe('parseRosterCsv', () => {
  it('parses simple email,user_id rows', () => {
    const out = parseRosterCsv('alice@school.edu,class:student_01\nbob@school.edu,class:student_02\n');
    expect(out).toEqual([
      { email: 'alice@school.edu', user_id: 'class:student_01' },
      { email: 'bob@school.edu', user_id: 'class:student_02' },
    ]);
  });

  it('skips an optional header row beginning with "email,"', () => {
    const out = parseRosterCsv('email,user_id\nalice@school.edu,class:student_01\n');
    expect(out).toEqual([{ email: 'alice@school.edu', user_id: 'class:student_01' }]);
  });

  it('ignores blank lines and `#` comment lines', () => {
    const out = parseRosterCsv('# fall 2026 roster\n\nalice@school.edu,class:student_01\n\n# end\n');
    expect(out).toEqual([{ email: 'alice@school.edu', user_id: 'class:student_01' }]);
  });

  it('drops rows missing either column', () => {
    const out = parseRosterCsv('alice@school.edu\nbob@school.edu,\n,class:s2\n');
    expect(out).toEqual([]);
  });

  it('trims surrounding whitespace from each cell', () => {
    const out = parseRosterCsv('  alice@school.edu , class:student_01\n');
    expect(out).toEqual([{ email: 'alice@school.edu', user_id: 'class:student_01' }]);
  });

  it('handles CRLF line endings', () => {
    const out = parseRosterCsv('alice@school.edu,class:s1\r\nbob@school.edu,class:s2\r\n');
    expect(out).toHaveLength(2);
  });
});
