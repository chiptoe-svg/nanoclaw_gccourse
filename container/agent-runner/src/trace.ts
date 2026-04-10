/**
 * Structured trace writer for the Agent Playground.
 *
 * Appends JSON-line events to /workspace/ipc/trace.jsonl. The host tails
 * this file and broadcasts lines via WebSocket to the playground's trace
 * pane.
 *
 * Designed to be imported by index.ts but fully safe to import even when
 * the playground isn't running — writes go to a file nobody reads, and
 * failures are silently swallowed. Zero impact on normal agent operation.
 */
import fs from 'fs';

const TRACE_FILE = '/workspace/ipc/trace.jsonl';

export function traceEvent(event: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: Date.now(), ...event });
    fs.appendFileSync(TRACE_FILE, line + '\n');
  } catch {
    // Non-fatal: tracing is best-effort.
  }
}
