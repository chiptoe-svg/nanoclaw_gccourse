/**
 * Reader for `data/class-config.json` written by `scripts/class-skeleton.ts`.
 *
 * The pair handler uses this to detect class flow (wire-to a `student_*`
 * folder that the skeleton script provisioned), and Phase 3b uses it to
 * resolve `driveParent` for per-student folder creation.
 *
 * Returns null if the file is absent — no class has been provisioned yet.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

export interface ClassConfig {
  driveParent: string | null;
  driveMountRoot: string | null;
  kb: string | null;
  wiki: string | null;
  students: Array<{ name: string; folder: string }>;
}

const FILE_NAME = 'class-config.json';

export function readClassConfig(): ClassConfig | null {
  const p = path.join(DATA_DIR, FILE_NAME);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ClassConfig>;
    if (!Array.isArray(parsed.students)) return null;
    return {
      driveParent: parsed.driveParent ?? null,
      driveMountRoot: parsed.driveMountRoot ?? null,
      kb: parsed.kb ?? null,
      wiki: parsed.wiki ?? null,
      students: parsed.students,
    };
  } catch (err) {
    log.warn('class-config parse failed; treating as no class provisioned', { err: String(err) });
    return null;
  }
}

/** Look up the student record matching a folder name (e.g. "student_07"). */
export function findClassStudent(folder: string): { name: string; folder: string } | null {
  const cfg = readClassConfig();
  if (!cfg) return null;
  return cfg.students.find((s) => s.folder === folder) ?? null;
}

/**
 * True when the folder belongs to a provisioned class student. Used by the
 * playground to lock down draft-mutation endpoints (only the persona pane
 * is editable for student drafts, so they can't change container.json,
 * skills, or provider — those stay instructor-controlled).
 */
export function isClassStudentFolder(folder: string): boolean {
  return findClassStudent(folder) !== null;
}
