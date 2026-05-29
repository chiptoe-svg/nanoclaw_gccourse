/**
 * Shared check: does the instructor (install owner) have a usable
 * credential for an auth-registry spec id? Used by:
 *
 *   - `models-tab-state.classPoolReady` so deriveProviderState's
 *     class-pool branch greys out when the credential is missing.
 *   - `class-controls.providedReady` so the Class Controls form
 *     disables the "Provided" checkbox for groups whose creds aren't
 *     connected — instructor sees "connect first" instead of toggling
 *     a policy that 502s every student request.
 *
 * Sibling fallback (codex ↔ openai-platform) mirrors the resolver's
 * SIBLING_API_KEY_SPECS map so the answer matches what
 * resolveStudentCreds will actually return at request time.
 */
import { loadStudentProviderCreds } from './student-provider-auth.js';
import { getOwnerUserId } from './modules/permissions/db/user-roles.js';

const SIBLING_API_KEY_SPECS: Record<string, string[]> = {
  codex: ['openai-platform'],
  'openai-platform': ['codex'],
};

export function ownerHasCredsForSpec(specId: string, ownerId?: string | null): boolean {
  const id = ownerId === undefined ? getOwnerUserId() : ownerId;
  if (!id) return false;
  const direct = loadStudentProviderCreds(id, specId);
  if (direct?.apiKey?.value || direct?.oauth?.accessToken) return true;
  for (const sib of SIBLING_API_KEY_SPECS[specId] ?? []) {
    const sibCreds = loadStudentProviderCreds(id, sib);
    if (sibCreds?.apiKey?.value) return true;
  }
  return false;
}
