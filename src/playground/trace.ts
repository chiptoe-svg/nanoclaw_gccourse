/**
 * Trace file tail + WebSocket broadcast, scoped per group.
 *
 * One watcher per group polls that group's trace.jsonl and broadcasts
 * new lines to listeners subscribed to that group. The active playground
 * draft is "pinned" so its watcher stays alive even with no WebSocket
 * subscribers (so events keep getting persisted into the draft session's
 * events.jsonl). Other groups' watchers are reference-counted and torn
 * down when their last subscriber disconnects.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { getDraftPaths } from './paths.js';
import { getCurrentTraceSessionId } from './run.js';

type Listener = (line: string) => void;

interface Watcher {
  interval: NodeJS.Timeout;
  offset: number;
  refCount: number;
  pinned: boolean;
}

const INITIAL_BACKLOG = 200;

const listenersByGroup = new Map<string, Set<Listener>>();
const watchers = new Map<string, Watcher>();
let activeDraftName: string | null = null;

function tracePath(group: string): string {
  return path.join(resolveGroupIpcPath(group), 'trace.jsonl');
}

function broadcast(group: string, line: string): void {
  const set = listenersByGroup.get(group);
  if (set) {
    for (const l of set) {
      try {
        l(line);
      } catch (err) {
        logger.debug({ err }, 'trace listener threw');
      }
    }
  }
  if (group === activeDraftName) {
    const sessionId = getCurrentTraceSessionId();
    if (sessionId) {
      const { sessionsDir } = getDraftPaths(group);
      const out = path.join(sessionsDir, sessionId, 'events.jsonl');
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.appendFileSync(out, line + '\n');
      } catch (err) {
        logger.debug({ err, sessionId }, 'failed to persist trace event');
      }
    }
  }
}

function drainFrom(group: string, file: string, from: number): number {
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
      if (line.trim()) broadcast(group, line);
    }
    return from + (len - Buffer.byteLength(last, 'utf-8'));
  } finally {
    fs.closeSync(fd);
  }
}

function ensureWatcher(group: string): Watcher {
  const existing = watchers.get(group);
  if (existing) return existing;
  const file = tracePath(group);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  const w: Watcher = {
    interval: null as unknown as NodeJS.Timeout,
    offset: fs.statSync(file).size,
    refCount: 0,
    pinned: false,
  };
  w.interval = setInterval(() => {
    try {
      w.offset = drainFrom(group, file, w.offset);
    } catch (err) {
      logger.debug({ err, group }, 'trace tail error');
    }
  }, 250);
  w.interval.unref();
  watchers.set(group, w);
  return w;
}

function maybeStopWatcher(group: string): void {
  const w = watchers.get(group);
  if (!w) return;
  if (w.refCount > 0 || w.pinned) return;
  clearInterval(w.interval);
  watchers.delete(group);
}

function replayBacklog(group: string, listener: Listener): void {
  try {
    const file = tracePath(group);
    if (!fs.existsSync(file)) return;
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    for (const l of lines.slice(-INITIAL_BACKLOG)) {
      try {
        listener(l);
      } catch {
        /* listener errors are non-fatal */
      }
    }
  } catch (err) {
    logger.debug({ err, group }, 'failed to replay trace backlog');
  }
}

export function subscribeTrace(group: string, listener: Listener): () => void {
  let set = listenersByGroup.get(group);
  if (!set) {
    set = new Set();
    listenersByGroup.set(group, set);
  }
  set.add(listener);
  const w = ensureWatcher(group);
  w.refCount++;
  replayBacklog(group, listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listenersByGroup.delete(group);
    w.refCount = Math.max(0, w.refCount - 1);
    maybeStopWatcher(group);
  };
}

export function startTraceWatcher(draftName: string): void {
  if (activeDraftName && activeDraftName !== draftName) {
    const prev = watchers.get(activeDraftName);
    if (prev) {
      prev.pinned = false;
      maybeStopWatcher(activeDraftName);
    }
  }
  activeDraftName = draftName;
  const w = ensureWatcher(draftName);
  w.pinned = true;
}

export function stopTraceWatcher(): void {
  if (!activeDraftName) return;
  const w = watchers.get(activeDraftName);
  if (w) {
    w.pinned = false;
    maybeStopWatcher(activeDraftName);
  }
  activeDraftName = null;
}

export function getActiveDraftName(): string | null {
  return activeDraftName;
}
