/**
 * Class-controls config — instructor-curated gates for what students see.
 *
 * v2 shape (wrapped by class for future multi-class):
 *   { classes: { "default": { tabsVisibleToStudents, authModesAvailable,
 *                              providers: { [providerId]: { allow,
 *                                provideDefault, allowByo } } } } }
 *
 * Backwards-compat: if existing file uses the flat v1 shape, hydrate
 * into the v2 shape on read with defaults for any missing fields.
 *
 * v1 was: { tabsVisibleToStudents, providersAvailable[], authModesAvailable }
 */
import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from '../../../config.js';
import { listProviderSpecs } from '../../../providers/auth-registry.js';
import type { ApiResult } from './me.js';

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'class-controls.json');

export type TabId = 'home' | 'chat' | 'persona' | 'skills' | 'models' | 'agents';
export type ProviderId = string; // registry-defined; loose-typed here
export type AuthModeId = 'api-key' | 'oauth' | 'claude-code-oauth';

export const DEFAULT_CLASS_ID = 'default';

export interface ProviderPolicy {
  allow: boolean;
  provideDefault: boolean;
  allowByo: boolean;
}

export interface ClassControl {
  tabsVisibleToStudents: TabId[];
  authModesAvailable: AuthModeId[];
  providers: Record<ProviderId, ProviderPolicy>;
}

export interface ClassControls {
  classes: Record<string, ClassControl>;
}

const DEFAULT_CLASS_CONTROL: ClassControl = {
  tabsVisibleToStudents: ['home', 'chat', 'persona', 'skills', 'models', 'agents'],
  authModesAvailable: ['api-key', 'oauth', 'claude-code-oauth'],
  providers: {
    claude: { allow: false, provideDefault: false, allowByo: false },
    codex: { allow: false, provideDefault: false, allowByo: false },
    'openai-platform': { allow: false, provideDefault: false, allowByo: false },
    omlx: { allow: true, provideDefault: true, allowByo: false },
  },
};

function defaultsRoot(): ClassControls {
  return { classes: { [DEFAULT_CLASS_ID]: structuredClone(DEFAULT_CLASS_CONTROL) } };
}

function isV1Flat(parsed: unknown): parsed is {
  tabsVisibleToStudents?: TabId[];
  providersAvailable?: string[];
  authModesAvailable?: AuthModeId[];
} {
  if (!parsed || typeof parsed !== 'object') return false;
  return 'providersAvailable' in parsed || ('tabsVisibleToStudents' in parsed && !('classes' in parsed));
}

function migrateV1(v1: {
  tabsVisibleToStudents?: TabId[];
  providersAvailable?: string[];
  authModesAvailable?: AuthModeId[];
}): ClassControls {
  // v1 was Mode A only — no BYO, no separate fallback toggle.
  // Migrate only the providers that were explicitly in providersAvailable.
  // Providers NOT in the v1 array stay out of the policies map entirely.
  const providers: Record<string, ProviderPolicy> = {};
  for (const p of v1.providersAvailable ?? []) {
    providers[p] = { allow: true, provideDefault: true, allowByo: false };
  }
  return {
    classes: {
      [DEFAULT_CLASS_ID]: {
        tabsVisibleToStudents: v1.tabsVisibleToStudents ?? DEFAULT_CLASS_CONTROL.tabsVisibleToStudents,
        authModesAvailable: v1.authModesAvailable ?? DEFAULT_CLASS_CONTROL.authModesAvailable,
        providers,
      },
    },
  };
}

export function readClassControls(): ClassControls {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return defaultsRoot();
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (isV1Flat(parsed)) return migrateV1(parsed);
    if (!parsed.classes || typeof parsed.classes !== 'object') return defaultsRoot();
    if (!parsed.classes[DEFAULT_CLASS_ID]) {
      parsed.classes[DEFAULT_CLASS_ID] = structuredClone(DEFAULT_CLASS_CONTROL);
    }
    return parsed as ClassControls;
  } catch {
    return defaultsRoot();
  }
}

export function writeClassControls(cc: ClassControls): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cc, null, 2) + '\n');
}

export function handleGetClassControls(): ApiResult<ClassControls> {
  return { status: 200, body: readClassControls() };
}

/**
 * Apply-to-class: for each given spec id, set allow=true AND
 * provideDefault=true (leave allowByo alone). Called by the instructor
 * LLM Providers card's "Apply to class" button. Server validates that
 * each spec id is actually a registered provider — prevents clients
 * from creating policies for unknown specs.
 *
 * The mapping from a user-facing "group" to its underlying spec ids
 * lives client-side in provider-groups.js; this endpoint just takes the
 * already-expanded specIds.
 */
export function handleApplyProviderToClass(body: { specIds?: unknown }): ApiResult<ClassControls> {
  if (!Array.isArray(body.specIds) || body.specIds.length === 0) {
    return { status: 400, body: { error: 'specIds: non-empty array required' } };
  }
  const registered = new Set(listProviderSpecs().map((s) => s.id));
  const cc = readClassControls();
  const cls = cc.classes[DEFAULT_CLASS_ID] ?? structuredClone(DEFAULT_CLASS_CONTROL);
  let touched = 0;
  for (const sid of body.specIds) {
    if (typeof sid !== 'string' || !registered.has(sid)) continue;
    const current = cls.providers[sid] ?? { allow: false, provideDefault: false, allowByo: false };
    cls.providers[sid] = { ...current, allow: true, provideDefault: true };
    touched++;
  }
  if (touched === 0) {
    return { status: 400, body: { error: 'no recognized specIds in request' } };
  }
  cc.classes[DEFAULT_CLASS_ID] = cls;
  try {
    writeClassControls(cc);
    return { status: 200, body: cc };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}

export function handlePutClassControls(body: Partial<ClassControls>): ApiResult<ClassControls> {
  if (!body.classes || typeof body.classes !== 'object') {
    return { status: 400, body: { error: 'classes object required' } };
  }
  const keys = Object.keys(body.classes);
  if (keys.length !== 1 || keys[0] !== DEFAULT_CLASS_ID) {
    return { status: 400, body: { error: `v1 supports only classId="${DEFAULT_CLASS_ID}"` } };
  }
  const next: ClassControls = { classes: { [DEFAULT_CLASS_ID]: body.classes[DEFAULT_CLASS_ID] as ClassControl } };
  try {
    writeClassControls(next);
    return { status: 200, body: next };
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } };
  }
}
