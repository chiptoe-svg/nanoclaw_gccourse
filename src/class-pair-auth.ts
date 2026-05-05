/**
 * Class feature (auth skill) — Codex auth-link pair consumer.
 *
 * Runs after a successful wire-to pairing for a class student. Issues
 * a fresh student-auth magic link via the existing magic-link server,
 * then sends the URL as a follow-up message so the student sees it
 * immediately without having to know about /login.
 *
 * Returns `{}` (no-op) for non-class pairings or when buildAuthUrl
 * returns null (NANOCLAW_PUBLIC_URL unset). In that fallback case
 * the student can still send /login later — once the public URL is
 * configured — and the auth flow works.
 */
import { findClassStudent } from './class-config.js';
import { registerPairConsumer, type PairContext, type PairResult } from './channels/pair-consumer-registry.js';
import { log } from './log.js';
import { buildAuthUrl, issueAuthToken } from './student-auth-server.js';

async function classPairAuth(ctx: PairContext): Promise<PairResult> {
  const student = findClassStudent(ctx.targetFolder);
  if (!student) return {};

  let url: string | null = null;
  try {
    const token = issueAuthToken(ctx.pairedUserId);
    url = buildAuthUrl(token);
  } catch (err) {
    log.warn('class-pair-auth: failed to issue token', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!url) return {}; // public URL not configured — silent skip; /login can retry later.

  return {
    confirmation: `Connect your ChatGPT account so I run on your subscription instead of your instructor's: ${url}\n(Send /login any time to get a fresh link. Run \`codex login\` on your laptop first to produce the auth.json this link asks for.)`,
  };
}

registerPairConsumer(classPairAuth);
