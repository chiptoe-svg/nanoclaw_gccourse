/**
 * Trace file tail + WebSocket broadcast, scoped to the active draft.
 *
 * When a draft session starts, startTraceWatcher(draftName) polls that
 * draft's trace.jsonl and broadcasts new lines to every connected
 * WebSocket client. stopTraceWatcher() tears down the watcher when the
 * session ends. WebSocket subscribers persist across draft sessions.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { getDraftPaths } from './paths.js';
import { getCurrentTraceSessionId } from './run.js';

type Listener = (line: string) => void;

const listeners = new Set<Listener>();

let activeDraftName: string | null = null;
let watchInterval: NodeJS.Timeout | null = null;
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
  if (activeDraftName && sessionId) {
    const { sessionsDir } = getDraftPaths(activeDraftName);
    const out = path.join(sessionsDir, sessionId, 'events.jsonl');
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.appendFileSync(out, line + '\n');
    } catch (err) {
      logger.debug({ err, sessionId }, 'failed to persist trace event');
    }
  }
}

function tracePath(draftName: string): string {
  return path.join(resolveGroupIpcPath(draftName), 'trace.jsonl');
}

function drainFrom(file: string, from: number): number {
  if (!fs.existsSync(file)) return from;
  const stat = fs.statSync(file);
  if (stat.size < from) from = 0;
  if (stat.size === from) return from;
  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - from;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    const last = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) broadcast(line);
    }
    return from + (len - Buffer.byteLength(last, 'utf-8'));
  } finally {
    fs.closeSync(fd);
  }
}

export function startTraceWatcher(draftName: string): void {
  stopTraceWatcher();
  activeDraftName = draftName;

  const file = tracePath(draftName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  readOffset = fs.statSync(file).size;

  watchInterval = setInterval(() => {
    try {
      readOffset = drainFrom(file, readOffset);
    } catch (err) {
      logger.debug({ err }, 'trace tail error');
    }
  }, 250);
  watchInterval.unref();
}

export function stopTraceWatcher(): void {
  if (watchInterval) {
    clearInterval(watchInterval);
    watchInterval = null;
  }
  activeDraftName = null;
  readOffset = 0;
}
