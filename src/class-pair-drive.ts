/**
 * Class feature (Google Workspace skill) — Drive folder pair consumer.
 *
 * Runs after a successful wire-to pairing. When the target is a class
 * student AND the email was captured AND the class has a configured
 * Drive parent, this consumer:
 *   1. Creates the per-student Drive folder via instructor OAuth.
 *   2. Shares it with the student's email.
 *   3. Persists folder ID + URL on the agent group's metadata.
 *   4. Sends a short follow-up message with the folder URL.
 *
 * Idempotent: re-pair with the same email is a no-op (createStudentFolder
 * checks for an existing folder name + permission). Drive errors are
 * logged but never fail the pairing.
 *
 * Lives separately from `class-pair-greeting.ts` so the gws skill can
 * register its own consumer without entangling the base. Returns
 * `{}` (no-op) when this isn't a class pairing or Drive isn't
 * configured — the greeting consumer's reply still fires.
 */
import { findClassStudent, readClassConfig } from './class-config.js';
import { createStudentFolder } from './class-drive.js';
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { getAgentGroupMetadata, setAgentGroupMetadataKey } from './db/agent-groups.js';
import { log } from './log.js';

async function classPairDrive(ctx: PairContext): Promise<PairResult> {
  const student = findClassStudent(ctx.targetFolder);
  if (!student) return {};
  if (!ctx.consumedEmail) return {};

  const classConfig = readClassConfig();
  if (!classConfig?.driveParent) return {};

  const meta = getAgentGroupMetadata(ctx.agentGroupId);
  const alreadyHas = typeof meta.drive_folder_id === 'string' && meta.drive_folder_id.length > 0;
  let folderUrl: string | null = typeof meta.drive_folder_url === 'string' ? meta.drive_folder_url : null;

  if (!alreadyHas) {
    try {
      const result = await createStudentFolder({
        parentFolderId: classConfig.driveParent,
        studentFolder: ctx.targetFolder,
        studentName: student.name,
        studentEmail: ctx.consumedEmail,
      });
      setAgentGroupMetadataKey(ctx.agentGroupId, 'drive_folder_id', result.folderId);
      setAgentGroupMetadataKey(ctx.agentGroupId, 'drive_folder_url', result.folderUrl);
      folderUrl = result.folderUrl;
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
      return {
        confirmation:
          '(Drive folder creation failed — your instructor will see the error in the host logs. Re-pair after they fix it to retry.)',
      };
    }
  }

  if (!folderUrl) return {};

  return {
    confirmation: `Your Google Drive folder is shared with you here: ${folderUrl}\n(Files saved here are visible to your instructor.)`,
  };
}

registerPairConsumer(classPairDrive);
