/**
 * Skeleton extensions barrel.
 *
 * `scripts/class-skeleton.ts` imports this for side effects. Each
 * imported module self-registers a contributor on
 * `src/skeleton-mount-registry.ts` (or any future skeleton-extension
 * registry).
 *
 * Default install (just `/add-classroom`): empty barrel — only the
 * base KB + wiki mounts the skeleton ships inline get written.
 *
 * Skills that need to extend the skeleton append imports here:
 *   `/add-classroom-gws` adds `import '../src/class-skeleton-drive-mount.js';`
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import '../src/class-skeleton-drive-mount.js';
