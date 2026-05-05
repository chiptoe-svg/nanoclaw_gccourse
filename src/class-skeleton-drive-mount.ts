/**
 * Class feature (Google Workspace skill) — provision-time Drive
 * bind-mount contributor.
 *
 * Reads `--drive-parent` and `--drive-mount-root` from process.argv,
 * persists them onto class-config.json (mutates the passed blob),
 * and emits a `/workspace/drive` bind-mount per student pointing at
 * `<root>/<folder> — <name>` (matching the folder name
 * `class-drive.ts` creates at pair time).
 *
 * Self-registers at import time so the gws skill just needs to add
 * `import './class-skeleton-drive-mount.js';` to
 * `scripts/class-skeleton-extensions.ts` (the barrel the script
 * imports for side effects).
 *
 * No-ops cleanly:
 *   - When `--drive-parent` isn't set: returns `[]` and does not
 *     write driveParent/driveMountRoot to class-config.
 *   - When the contributor runs but Drive isn't actually configured
 *     yet: still emits a mount path the rclone process will fill in
 *     once the instructor sets up the Drive (the path doesn't have
 *     to exist on disk at provisioning time).
 */
import os from 'os';
import path from 'path';

import { registerSkeletonMountContributor } from './skeleton-mount-registry.js';

function readFlag(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] ?? null : null;
}

registerSkeletonMountContributor((ctx) => {
  const driveParent = readFlag(ctx.argv, '--drive-parent');
  if (!driveParent) return [];

  const driveMountRoot = readFlag(ctx.argv, '--drive-mount-root') ?? path.join(os.homedir(), 'nanoclaw-drive-mount');

  // Persist the gws-specific class-config fields by mutating the
  // passed blob. The script writes class-config.json after running
  // contributors, so this lands in the file.
  ctx.classConfig.driveParent = driveParent;
  ctx.classConfig.driveMountRoot = path.resolve(driveMountRoot);

  // Folder name format mirrors `class-drive.ts`'s `createStudentFolder`:
  // "<studentFolder> — <studentName>" (em dash).
  const hostPath = path.join(path.resolve(driveMountRoot), `${ctx.studentFolder} — ${ctx.studentName}`);
  return [
    {
      hostPath,
      containerPath: '/workspace/drive',
      readonly: false,
    },
  ];
});
