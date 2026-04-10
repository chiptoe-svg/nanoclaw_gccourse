/**
 * Draft agent runner — calls runContainerAgent() directly with a synthetic
 * RegisteredGroup pointing at groups/draft/. Bypasses the channel message
 * loop and IPC watcher entirely.
 *
 * A single-turn model for now: each chat message spawns a fresh container
 * (or shares one mid-turn via resume). The SDK sessionId is persisted in
 * memory across turns so the conversation resumes. The sessionId is
 * invalidated whenever the persona or skills change (host handles that via
 * `invalidateSession`).
 *
 * Trace capture: the draft group's IPC dir contains a trace.jsonl file
 * that the container writes to. A tail watcher (trace.ts) streams lines
 * to connected WebSocket clients.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath, resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { runContainerAgent, ContainerOutput } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { DRAFT_ATTACHMENTS_DIR, DRAFT_GROUP_FOLDER, DRAFT_SESSIONS_DIR } from './paths.js';

// In-memory draft session state. Not persisted across server restarts.
let currentSessionId: string | undefined;
let currentTraceSessionId: string | null = null;
const activeProcesses = new Set<ChildProcess>();

export function invalidateSession(): void {
  currentSessionId = undefined;
  currentTraceSessionId = null;
}

export function getCurrentTraceSessionId(): string | null {
  return currentTraceSessionId;
}

function syntheticDraftGroup(): RegisteredGroup {
  return {
    name: 'Playground Draft',
    folder: DRAFT_GROUP_FOLDER,
    trigger: '',
    added_at: new Date().toISOString(),
    isMain: false,
    requiresTrigger: false,
    containerConfig: {
      // Playground turns are interactive — shorter timeout is fine.
      timeout: 600_000,
    },
  };
}

/**
 * Prepare a new trace session and reset the in-container trace.jsonl.
 */
function startTraceSession(): string {
  const sessionId = `s${Date.now()}`;
  fs.mkdirSync(path.join(DRAFT_SESSIONS_DIR, sessionId), { recursive: true });
  // The container writes to /workspace/ipc/trace.jsonl. Truncate the host-
  // side file so this turn's trace is fresh.
  const ipcDir = resolveGroupIpcPath(DRAFT_GROUP_FOLDER);
  fs.mkdirSync(ipcDir, { recursive: true });
  const tracePath = path.join(ipcDir, 'trace.jsonl');
  fs.writeFileSync(tracePath, '');
  currentTraceSessionId = sessionId;
  return sessionId;
}

/**
 * Collect any files currently in the attachments directory, return them
 * inline as base64 MessageImage objects for the container. (NanoClaw's
 * container pipeline already supports images; other file types pass
 * through as attachments the agent can read from /workspace/group/
 * attachments/ — copied below.)
 */
function collectAttachments(): {
  images: { base64: string; mimeType: string }[];
  files: string[];
} {
  const images: { base64: string; mimeType: string }[] = [];
  const files: string[] = [];
  if (!fs.existsSync(DRAFT_ATTACHMENTS_DIR)) return { images, files };
  for (const name of fs.readdirSync(DRAFT_ATTACHMENTS_DIR)) {
    const full = path.join(DRAFT_ATTACHMENTS_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      const mimeType =
        ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
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

function clearAttachments(): void {
  if (!fs.existsSync(DRAFT_ATTACHMENTS_DIR)) return;
  for (const name of fs.readdirSync(DRAFT_ATTACHMENTS_DIR)) {
    try {
      fs.rmSync(path.join(DRAFT_ATTACHMENTS_DIR, name), { force: true, recursive: true });
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

// Directory basenames inside groups/draft/ that should NEVER appear as
// agent-produced files (they're host-managed bookkeeping).
const FILE_SNAPSHOT_EXCLUDE = new Set([
  'logs',
  '.history',
  'memory',
  'conversations',
  'attachments', // host-uploaded attachments, not agent output
  'CLAUDE.md',   // the persona itself
]);

type Snapshot = Map<string, number>; // relative path -> mtimeMs

function snapshotDraftFiles(): Snapshot {
  const out: Snapshot = new Map();
  const draftGroupDir = resolveGroupFolderPath(DRAFT_GROUP_FOLDER);
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

function diffSnapshots(before: Snapshot, after: Snapshot): Array<{ path: string; size: number }> {
  const draftGroupDir = resolveGroupFolderPath(DRAFT_GROUP_FOLDER);
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
  // Most recently touched first
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Run a single draft chat turn. Returns the first assistant reply.
 */
export async function runDraftTurn(prompt: string): Promise<RunResult> {
  const traceSessionId = startTraceSession();
  const group = syntheticDraftGroup();
  const { images, files } = collectAttachments();
  const preSnapshot = snapshotDraftFiles();

  // If non-image files were dropped, copy them into the draft group's
  // working directory so the agent can read them. (Image payloads go
  // inline as multimodal content blocks.)
  if (files.length > 0) {
    const groupAttachments = path.join('groups', DRAFT_GROUP_FOLDER, 'attachments');
    fs.mkdirSync(groupAttachments, { recursive: true });
    for (const name of files) {
      fs.copyFileSync(
        path.join(DRAFT_ATTACHMENTS_DIR, name),
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
      const ipcDir = resolveGroupIpcPath(DRAFT_GROUP_FOLDER);
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
        groupFolder: DRAFT_GROUP_FOLDER,
        chatJid: 'playground:draft',
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
          // First text result = reply. Ask the container to exit
          // immediately — otherwise its runQuery loop waits for a
          // follow-up IPC message and the HTTP request hangs until
          // IDLE_TIMEOUT fires on the host side.
          reply = chunk.result;
          writeClose();
        }
      },
    );
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  clearAttachments();
  // Safety net — close even if no result was seen (error path).
  writeClose();

  if (output?.status === 'error' && output.error) {
    lastError = output.error;
  }

  const postSnapshot = snapshotDraftFiles();
  const createdFiles = diffSnapshots(preSnapshot, postSnapshot);

  return {
    sessionId: traceSessionId,
    reply,
    error: lastError,
    files: createdFiles,
  };
}

/**
 * Graceful shutdown — kill any in-flight draft container.
 */
export function stopAllDraftRuns(): void {
  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
