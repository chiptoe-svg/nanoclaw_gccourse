/**
 * Class welcome-message composition.
 *
 * Rendered immediately after a successful class pairing — replaces the
 * generic "Pairing success!" confirmation. The text is plain Telegram
 * (no parse_mode); URLs auto-link.
 *
 * Customization: an instructor can drop `data/class-welcome.md` next to
 * `class-config.json` to override the default. Variables `{name}` and
 * `{drive_url}` get substituted. Missing variables fall back to a sane
 * neutral string so a partial render still reads naturally.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

const TEMPLATE_FILENAME = 'class-welcome.md';

const DEFAULT_TEMPLATE = `Hi {name}! Welcome to class.

Quick orientation:

• Your Drive folder is shared with you here: {drive_url}
  (Files saved here are visible to your instructor.)

• Send /playground to customize my personality and style. You can edit
  my persona freely — it only affects how I talk to you.

• I have read access to the class knowledgebase and read/write access
  to a shared class wiki. Anything you contribute to the wiki is
  attributed to you.

Heads up on privacy: your conversations with me, your persona edits,
and your wiki contributions are visible to your instructor. The class
knowledgebase and wiki are shared with all classmates. This is course
material, so use it freely.

Ready when you are.`;

export interface ClassWelcomeContext {
  name: string;
  driveUrl?: string | null;
}

/**
 * Render the welcome message text for a given student.
 *
 * Reads `data/class-welcome.md` when present so the instructor can edit
 * the message without code changes. Falls back to DEFAULT_TEMPLATE.
 *
 * Substitutions:
 *   {name}      → ctx.name (always present — pulled from class config)
 *   {drive_url} → ctx.driveUrl, or "(Drive folder pending — check back
 *                 in a minute)" when null/empty so the message stays
 *                 readable even if Drive folder creation failed/skipped.
 */
export function getClassWelcomeText(ctx: ClassWelcomeContext): string {
  const template = readTemplate();
  const driveUrl =
    ctx.driveUrl && ctx.driveUrl.length > 0 ? ctx.driveUrl : '(Drive folder pending — check back in a minute)';
  return template.replaceAll('{name}', ctx.name).replaceAll('{drive_url}', driveUrl);
}

function readTemplate(): string {
  const p = path.join(DATA_DIR, TEMPLATE_FILENAME);
  try {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      if (text.trim().length > 0) return text;
    }
  } catch {
    // Fall through to default; an unreadable override shouldn't break pairing.
  }
  return DEFAULT_TEMPLATE;
}
