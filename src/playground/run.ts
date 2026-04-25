/**
 * Draft agent runner — runs a single chat turn against an active draft.
 * Takes the draft name and spawns a container rooted at groups/<draftName>/.
 *
 * The SDK sessionId is kept in memory across turns so the conversation
 * resumes. When the active draft changes (session start/end) or the
 * persona/skills/global CLAUDE.md are edited, resetRunSingletons() or
 * invalidateSession() are called.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { logger } from '../logger.js';
import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { getDraftPaths } from './paths.js';

// In-memory draft session state. Not persisted across server restarts.
let currentSessionId: string | undefined;
let currentTraceSessionId: string | null = null;
const activeProcesses = new Set<ChildProcess>();

export function invalidateSession(): void {
  currentSessionId = undefined;
  currentTraceSessionId = null;
}

/**
 * Hard reset — drop the SDK session and kill any in-flight container.
 * Called by the session manager when the active draft changes.
 */
export function resetRunSingletons(): void {
  invalidateSession();
  stopAllDraftRuns();
}

export function getCurrentTraceSessionId(): string | null {
  return currentTraceSessionId;
}

function syntheticDraftGroup(draftName: string): RegisteredGroup {
  return {
    name: `Playground ${draftName}`,
    folder: draftName,
    trigger: '',
    added_at: new Date().toISOString(),
    isMain: false,
    requiresTrigger: false,
    containerConfig: {
      timeout: 600_000,
    },
  };
}

/**
 * Prepare a new trace session and reset the in-container trace.jsonl.
 */
function startTraceSession(draftName: string): string {
  const paths = getDraftPaths(draftName);
  const sessionId = `s${Date.now()}`;
  fs.mkdirSync(path.join(paths.sessionsDir, sessionId), { recursive: true });
  const ipcDir = resolveGroupIpcPath(draftName);
  fs.mkdirSync(ipcDir, { recursive: true });
  const tracePath = path.join(ipcDir, 'trace.jsonl');
  fs.writeFileSync(tracePath, '');
  currentTraceSessionId = sessionId;
  return sessionId;
}

function collectAttachments(draftName: string): {
  images: { base64: string; mimeType: string }[];
  files: string[];
} {
  const { attachmentsDir } = getDraftPaths(draftName);
  const images: { base64: string; mimeType: string }[] = [];
  const files: string[] = [];
  if (!fs.existsSync(attachmentsDir)) return { images, files };
  for (const name of fs.readdirSync(attachmentsDir)) {
    const full = path.join(attachmentsDir, name);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      const mimeType =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'image/jpeg';
      images.push({
        base64: fs.readFileSync(full).toString('base64'),
        mimeType,
      });
    } else {
      files.push(name);
    }
  }
  return { images, files };
}

function clearAttachments(draftName: string): void {
  const { attachmentsDir } = getDraftPaths(draftName);
  if (!fs.existsSync(attachmentsDir)) return;
  for (const name of fs.readdirSync(attachmentsDir)) {
    try {
      fs.rmSync(path.join(attachmentsDir, name), {
        force: true,
        recursive: true,
      });
    } catch {
      /* ignore */
    }
  }
}

export interface RunResult {
  sessionId: string;
  reply: string;
  error?: string;
  files: Array<{ path: string; size: number }>;
}

const FILE_SNAPSHOT_EXCLUDE = new Set([
  'logs',
  '.history',
  'memory',
  'conversations',
  'attachments',
  'CLAUDE.md',
]);

type Snapshot = Map<string, number>;

function snapshotDraftFiles(draftName: string): Snapshot {
  const out: Snapshot = new Map();
  const draftGroupDir = resolveGroupFolderPath(draftName);
  if (!fs.existsSync(draftGroupDir)) return out;
  const walk = (absDir: string, relDir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (FILE_SNAPSHOT_EXCLUDE.has(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          out.set(rel, fs.statSync(abs).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(draftGroupDir, '');
  return out;
}

function diffSnapshots(
  draftName: string,
  before: Snapshot,
  after: Snapshot,
): Array<{ path: string; size: number }> {
  const draftGroupDir = resolveGroupFolderPath(draftName);
  const changed: Array<{ path: string; size: number }> = [];
  for (const [rel, mtime] of after.entries()) {
    const prior = before.get(rel);
    if (prior === undefined || mtime > prior) {
      try {
        const stat = fs.statSync(path.join(draftGroupDir, rel));
        changed.push({ path: rel, size: stat.size });
      } catch {
        /* ignore */
      }
    }
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runDraftTurn(
  draftName: string,
  prompt: string,
): Promise<RunResult> {
  const traceSessionId = startTraceSession(draftName);
  const group = syntheticDraftGroup(draftName);
  const { images, files } = collectAttachments(draftName);
  const preSnapshot = snapshotDraftFiles(draftName);

  if (files.length > 0) {
    const groupAttachments = path.join(
      'groups',
      draftName,
      'attachments',
    );
    fs.mkdirSync(groupAttachments, { recursive: true });
    const { attachmentsDir } = getDraftPaths(draftName);
    for (const name of files) {
      fs.copyFileSync(
        path.join(attachmentsDir, name),
        path.join(groupAttachments, name),
      );
    }
  }

  let reply = '';
  let lastError: string | undefined;
  let output: ContainerOutput | undefined;
  let closeWritten = false;

  const writeClose = () => {
    if (closeWritten) return;
    closeWritten = true;
    try {
      const ipcDir = resolveGroupIpcPath(draftName);
      fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
      fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
    } catch (err) {
      logger.debug({ err }, 'Failed to write close sentinel');
    }
  };

  try {
    output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: currentSessionId,
        groupFolder: draftName,
        chatJid: `playground:${draftName}`,
        isMain: false,
        assistantName: 'Draft',
        images: images.length > 0 ? images : undefined,
      },
      (proc) => {
        activeProcesses.add(proc);
        proc.on('close', () => activeProcesses.delete(proc));
      },
      async (chunk) => {
        if (chunk.newSessionId) {
          currentSessionId = chunk.newSessionId;
        }
        if (chunk.status === 'error' && chunk.error) {
          lastError = chunk.error;
        }
        if (chunk.result) {
          reply = chunk.result;
          writeClose();
        }
      },
    );
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  clearAttachments(draftName);
  writeClose();

  if (output?.status === 'error' && output.error) {
    lastError = output.error;
  }

  const postSnapshot = snapshotDraftFiles(draftName);
  const createdFiles = diffSnapshots(draftName, preSnapshot, postSnapshot);

  return {
    sessionId: traceSessionId,
    reply,
    error: lastError,
    files: createdFiles,
  };
}

export function stopAllDraftRuns(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
