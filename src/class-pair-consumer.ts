/**
 * Class feature — post-pair consumer.
 *
 * Runs after a successful wire-to pairing. When the target folder
 * matches a provisioned class student, this consumer:
 *   1. Stamps student_email, student_name, student_user_id on the
 *      agent group's metadata so downstream features (per-student
 *      Codex auth, git author env injection, etc.) can find them.
 *   2. Creates the per-student Drive folder via the instructor's
 *      OAuth + shares with the student. Inline (not background) so
 *      the welcome message can include the folder URL. Drive errors
 *      log but don't fail pairing — student can re-pair to retry.
 *   3. Issues a fresh student-auth magic link for the welcome.
 *   4. Composes the welcome and returns it as the confirmation,
 *      suppressing the channel's generic "Pairing success!".
 *
 * Non-class targets (paths that aren't in `class-config.json`) get
 * an empty result so the channel sends its default confirmation.
 */
import { readClassConfig, findClassStudent } from './class-config.js';
import { createStudentFolder } from './class-drive.js';
import { getClassWelcomeText } from './class-welcome.js';
import {
  registerPairConsumer,
  type PairContext,
  type PairResult,
} from './channels/pair-consumer-registry.js';
import { getAgentGroupMetadata, setAgentGroupMetadataKey } from './db/agent-groups.js';
import { log } from './log.js';
import { buildAuthUrl, issueAuthToken } from './student-auth-server.js';

async function classPairConsumer(ctx: PairContext): Promise<PairResult> {
  const student = findClassStudent(ctx.targetFolder);
  if (!student) return {}; // not a class flow — fall through to default confirmation.

  if (ctx.consumedEmail) {
    setAgentGroupMetadataKey(ctx.agentGroupId, 'student_email', ctx.consumedEmail);
  }
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_name', student.name);
  setAgentGroupMetadataKey(ctx.agentGroupId, 'student_user_id', ctx.pairedUserId);

  const classConfig = readClassConfig();
  const meta = getAgentGroupMetadata(ctx.agentGroupId);
  const alreadyHas = typeof meta.drive_folder_id === 'string' && meta.drive_folder_id.length > 0;
  if (ctx.consumedEmail && classConfig?.driveParent && !alreadyHas) {
    try {
      const result = await createStudentFolder({
        parentFolderId: classConfig.driveParent,
        studentFolder: ctx.targetFolder,
        studentName: student.name,
        studentEmail: ctx.consumedEmail,
      });
      setAgentGroupMetadataKey(ctx.agentGroupId, 'drive_folder_id', result.folderId);
      setAgentGroupMetadataKey(ctx.agentGroupId, 'drive_folder_url', result.folderUrl);
      log.info('Class Drive folder ready', {
        folder: ctx.targetFolder,
        folderId: result.folderId,
        created: result.created,
        shared: result.shared,
      });
    } catch (driveErr) {
      log.error('Class Drive folder creation failed', {
        folder: ctx.targetFolder,
        err: driveErr instanceof Error ? driveErr.message : String(driveErr),
      });
    }
  }

  // Welcome message. The drive URL falls back to a "pending" placeholder
  // when absent, so a transient Drive error doesn't strand the student
  // without orientation.
  const finalMeta = getAgentGroupMetadata(ctx.agentGroupId);
  const driveUrl = typeof finalMeta.drive_folder_url === 'string' ? finalMeta.drive_folder_url : null;

  // Fresh Codex-auth magic link for the welcome. buildAuthUrl returns
  // null when NANOCLAW_PUBLIC_URL is unset — welcome template handles
  // that case with a "ask your instructor" fallback.
  let authUrl: string | null = null;
  try {
    const token = issueAuthToken(ctx.pairedUserId);
    authUrl = buildAuthUrl(token);
  } catch (err) {
    log.warn('Class welcome: failed to issue auth token', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    confirmation: getClassWelcomeText({ name: student.name, driveUrl, authUrl }),
    suppressDefaultConfirmation: true,
  };
}

registerPairConsumer(classPairConsumer);
