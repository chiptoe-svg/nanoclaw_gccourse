/**
 * Class feature — playground draft-mutation gate.
 *
 * Locks down the playground's three mutate endpoints (file PUT,
 * skills PUT, provider PUT) for any draft whose target is a
 * provisioned class student. The persona endpoint stays open
 * because it has no gate check — students customize their
 * `CLAUDE.local.md` freely; everything else is instructor-curated.
 *
 * Reasoning preserved here (out of playground.ts) so the playground
 * core is class-agnostic again.
 */
import { targetFolderOf } from './agent-builder/core.js';
import { registerDraftMutationGate } from './channels/playground-gate-registry.js';
import { isClassStudentFolder } from './class-config.js';

const STUDENT_LOCKED_MESSAGE =
  'Class-student drafts only allow persona edits. Use the persona pane to edit CLAUDE.local.md.';

function isClassStudentDraft(draftFolder: string): boolean {
  try {
    return isClassStudentFolder(targetFolderOf(draftFolder));
  } catch {
    return false; // not a draft folder — let other gates / default decide
  }
}

registerDraftMutationGate((draftFolder) => {
  if (isClassStudentDraft(draftFolder)) {
    return { allow: false, reason: STUDENT_LOCKED_MESSAGE };
  }
  return { allow: true };
});
