/**
 * Class feature — per-student Codex auth resolver.
 *
 * Registers a CodexAuthResolver that pulls the per-student auth.json
 * stored by the magic-link flow (`src/student-auth.ts`). Registered
 * BEFORE the default instructor resolver in `src/index.ts`'s class
 * import block, so a student with a stored auth.json always shadows
 * the instructor's host auth.
 *
 * If `agent_groups.metadata.student_user_id` is unset (e.g. the agent
 * group isn't class-wired) or the student hasn't uploaded yet, this
 * resolver returns null and the chain falls through to the default
 * instructor resolver. That's the "graceful migration" path —
 * unauthed class students still work on the instructor's tab until
 * they upload their own auth.
 */
import { getAgentGroupMetadata } from './db/agent-groups.js';
import { type CodexAuthResolver, registerCodexAuthResolver } from './providers/codex.js';
import { getStudentAuthPath } from './student-auth.js';

/**
 * Returns the per-student auth.json path when the agent group is
 * class-wired AND the student has uploaded their auth.json via the
 * magic-link flow. Returns null otherwise so the chain falls through
 * to the next resolver (typically the instructor host fallback).
 *
 * Exported so tests can register it against a freshly reset chain.
 */
export const studentCodexAuthResolver: CodexAuthResolver = (ctx) => {
  const meta = getAgentGroupMetadata(ctx.agentGroupId);
  const studentUserId = typeof meta.student_user_id === 'string' ? meta.student_user_id : null;
  if (!studentUserId) return null;
  const studentPath = getStudentAuthPath(studentUserId);
  if (!studentPath) return null;
  return { name: 'student', path: studentPath };
};

registerCodexAuthResolver(studentCodexAuthResolver);
