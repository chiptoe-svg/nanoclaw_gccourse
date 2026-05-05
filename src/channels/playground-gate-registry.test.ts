/**
 * Pure registry tests for playground-gate-registry. The integration
 * with the class feature is covered by class-config tests + the
 * playground's HTTP behavior tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _resetGatesForTest,
  checkDraftMutation,
  registerDraftMutationGate,
  type DraftMutationAction,
} from './playground-gate-registry.js';

describe('checkDraftMutation', () => {
  beforeEach(() => _resetGatesForTest());

  it('allows when no gates are registered (default install)', () => {
    expect(checkDraftMutation('draft_main', 'file_put')).toEqual({ allow: true });
    expect(checkDraftMutation('draft_main', 'skills_put')).toEqual({ allow: true });
    expect(checkDraftMutation('draft_main', 'provider_put')).toEqual({ allow: true });
  });

  it('returns the first-registered gate that denies', () => {
    registerDraftMutationGate(() => ({ allow: false, reason: 'first' }));
    registerDraftMutationGate(() => ({ allow: false, reason: 'second' }));
    expect(checkDraftMutation('draft_main', 'file_put')).toEqual({
      allow: false,
      reason: 'first',
    });
  });

  it('skips gates that allow and returns deny from a later gate', () => {
    registerDraftMutationGate(() => ({ allow: true }));
    registerDraftMutationGate(() => ({ allow: false, reason: 'denied here' }));
    expect(checkDraftMutation('draft_main', 'skills_put')).toEqual({
      allow: false,
      reason: 'denied here',
    });
  });

  it('returns allow when every gate allows', () => {
    registerDraftMutationGate(() => ({ allow: true }));
    registerDraftMutationGate(() => ({ allow: true }));
    expect(checkDraftMutation('draft_main', 'provider_put')).toEqual({ allow: true });
  });

  it('passes the draft folder and action through to gates', () => {
    const seen: Array<{ folder: string; action: DraftMutationAction }> = [];
    registerDraftMutationGate((folder, action) => {
      seen.push({ folder, action });
      return { allow: true };
    });
    checkDraftMutation('draft_student_07', 'file_put');
    checkDraftMutation('draft_main', 'skills_put');
    expect(seen).toEqual([
      { folder: 'draft_student_07', action: 'file_put' },
      { folder: 'draft_main', action: 'skills_put' },
    ]);
  });

  it('returns deny without a reason when the gate omits one', () => {
    registerDraftMutationGate(() => ({ allow: false }));
    const decision = checkDraftMutation('draft_main', 'file_put');
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBeUndefined();
  });
});
