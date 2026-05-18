/**
 * Class-controls config — instructor-curated gates for what students see.
 *
 * Stored at config/class-controls.json. Owner-only writes. Read by every
 * playground bootstrap so the UI hides tabs/providers/auth-modes the
 * instructor has disabled. Owner role always sees the full set
 * regardless of these toggles (they're for student visibility, not
 * for locking the instructor out of their own controls).
 *
 * Default (no config file present): all tabs/providers/auth-modes
 * available — matches the pre-controls behavior so nothing breaks for
 * installs that never touch this file.
 */
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../../../config.js';
import type { ApiResult } from './me.js';

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'class-controls.json');

export type TabId = 'home' | 'chat' | 'persona' | 'skills' | 'models';
export type ProviderId = 'claude' | 'codex' | 'local';
export type AuthModeId = 'api-key' | 'oauth' | 'claude-code-oauth';

export interface ClassControls {
  tabsVisibleToStudents: TabId[];
  providersAvailable: ProviderId[];
  authModesAvailable: AuthModeId[];
}

const DEFAULTS: ClassControls = {
  tabsVisibleToStudents: ['home', 'chat', 'persona', 'skills', 'models'],
  providersAvailable: ['claude', 'codex', 'local'],
  authModesAvailable: ['api-key', 'oauth', 'claude-code-oauth'],
};

export function readClassControls(): ClassControls {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return {
      tabsVisibleToStudents: sanitizeArr(parsed.tabsVisibleToStudents, DEFAULTS.tabsVisibleToStudents),
      providersAvailable: sanitizeArr(parsed.providersAvailable, DEFAULTS.providersAvailable),
      authModesAvailable: sanitizeArr(parsed.authModesAvailable, DEFAULTS.authModesAvailable),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizeArr<T extends string>(value: unknown, allowed: T[]): T[] {
  if (!Array.isArray(value)) return [...allowed];
  return value.filter((v): v is T => allowed.includes(v as T));
}

export function handleGetClassControls(): ApiResult<ClassControls> {
  return { status: 200, body: readClassControls() };
}

export function handlePutClassControls(body: Partial<ClassControls>): ApiResult<ClassControls> {
  const current = readClassControls();
  const next: ClassControls = {
    tabsVisibleToStudents: Array.isArray(body.tabsVisibleToStudents)
      ? sanitizeArr(body.tabsVisibleToStudents, DEFAULTS.tabsVisibleToStudents)
      : current.tabsVisibleToStudents,
    providersAvailable: Array.isArray(body.providersAvailable)
      ? sanitizeArr(body.providersAvailable, DEFAULTS.providersAvailable)
      : current.providersAvailable,
    authModesAvailable: Array.isArray(body.authModesAvailable)
      ? sanitizeArr(body.authModesAvailable, DEFAULTS.authModesAvailable)
      : current.authModesAvailable,
  };
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n');
    return { status: 200, body: next };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
