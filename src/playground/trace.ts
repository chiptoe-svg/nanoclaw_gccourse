/**
 * Trace file tail + WebSocket broadcast.
 *
 * The draft container writes structured events to
 * /workspace/ipc/trace.jsonl inside the container. On the host, this maps
 * to {DATA_DIR}/ipc/draft/trace.jsonl. We watch the file for appends and
 * broadcast new lines to every connected WebSocket client, while also
 * copying each event into the current trace session's events.jsonl file
 * so a reload can replay past turns.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { DRAFT_GROUP_FOLDER, DRAFT_SESSIONS_DIR } from './paths.js';
import { getCurrentTraceSessionId } from './run.js';

type Listener = (line: string) => void;

const listeners = new Set<Listener>();

let watchStarted = false;
let readOffset = 0;

export function subscribeTrace(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function broadcast(line: string): void {
  for (const l of listeners) {
    try {
      l(line);
    } catch (err) {
      logger.debug({ err }, 'trace listener threw');
    }
  }
  const sessionId = getCurrentTraceSessionId();
  if (sessionId) {
    const out = path.join(DRAFT_SESSIONS_DIR, sessionId, 'events.jsonl');
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.appendFileSync(out, line + '\n');
    } catch (err) {
      logger.debug({ err, sessionId }, 'failed to persist trace event');
    }
  }
}

function tracePath(): string {
  return path.join(resolveGroupIpcPath(DRAFT_GROUP_FOLDER), 'trace.jsonl');
}

function drainFrom(file: string, from: number): number {
  if (!fs.existsSync(file)) return from;
  const stat = fs.statSync(file);
  // File was truncated (new turn) — reset.
  if (stat.size < from) from = 0;
  if (stat.size === from) return from;
  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - from;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    // Keep the last (potentially partial) line unprocessed — we'll re-read
    // it next tick once the writer finishes.
    const last = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) broadcast(line);
    }
    return from + (len - Buffer.byteLength(last, 'utf-8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Start the watcher. Idempotent — safe to call multiple times.
 */
export function startTraceWatcher(): void {
  if (watchStarted) return;
  watchStarted = true;

  const file = tracePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  readOffset = fs.statSync(file).size;

  // Poll every 250ms. Cheap; we only care about a file that grows during
  // a draft turn, and fs.watch is unreliable for append-only logs across
  // platforms.
  setInterval(() => {
    try {
      readOffset = drainFrom(file, readOffset);
    } catch (err) {
      logger.debug({ err }, 'trace tail error');
    }
  }, 250).unref();
}
