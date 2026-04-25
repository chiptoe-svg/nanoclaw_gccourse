/**
 * Dashboard pusher (v1 schema port).
 *
 * Collects NanoClaw state from the v1 single-file SQLite schema and the
 * filesystem, then POSTs a JSON snapshot to the dashboard's /api/ingest
 * endpoint. Also tails logs/nanoclaw.log into /api/logs/push.
 *
 * The dashboard package was written against the upstream v2 schema
 * (agent_groups / messaging_groups / sessions / users tables). This
 * fork uses v1 (registered_groups + flat sessions). We map v1 concepts
 * onto the dashboard's expected snapshot shape: each registered_group
 * becomes one agent_group + one messaging_group + one wiring, and
 * users/destinations/admins are emitted as empty arrays.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  PROJECT_ROOT,
  STORE_DIR,
} from './config.js';
import { getRegisteredChannelNames } from './channels/registry.js';
import { getAllRegisteredGroups, getAllSessions } from './db.js';
import { logger } from './logger.js';
import { Channel } from './types.js';
import Database from 'better-sqlite3';

interface PusherConfig {
  port: number;
  secret: string;
  intervalMs?: number;
  getChannels: () => Channel[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;
let getChannelsRef: () => Channel[] = () => [];

function channelTypeFromJid(jid: string): string {
  for (const ch of getChannelsRef()) {
    try {
      if (ch.ownsJid(jid)) return ch.name;
    } catch {
      /* skip */
    }
  }
  // Fallbacks for known formats when no live channel matches
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us'))
    return 'whatsapp';
  if (jid.startsWith('tg:')) return 'telegram';
  const m = jid.match(/^([a-z]+)[_:]/);
  return m ? m[1] : 'unknown';
}

export function startDashboardPusher(config: PusherConfig): void {
  const interval = config.intervalMs || 60000;
  getChannelsRef = config.getChannels;

  push(config).catch((err) =>
    logger.error({ err }, 'Dashboard push failed'),
  );
  timer = setInterval(() => {
    push(config).catch((err) =>
      logger.error({ err }, 'Dashboard push failed'),
    );
  }, interval);

  startLogTail(config);

  logger.info({ intervalMs: interval }, 'Dashboard pusher started');
}

export function stopDashboardPusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

function postJson(
  config: PusherConfig,
  urlPath: string,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port: config.port,
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${config.secret}`,
    },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function startLogTail(config: PusherConfig): void {
  const logFile = path.resolve(PROJECT_ROOT, 'logs', 'nanoclaw.log');
  if (!fs.existsSync(logFile)) return;

  try {
    const allLines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    logOffset = fs.statSync(logFile).size;
    const tail = allLines.slice(-200).map((l) => l.replace(ANSI_RE, ''));
    if (tail.length > 0) postJson(config, '/api/logs/push', { lines: tail });
  } catch {
    return;
  }

  logTimer = setInterval(() => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= logOffset) {
        logOffset = stat.size;
        return;
      }
      const buf = Buffer.alloc(stat.size - logOffset);
      const fd = fs.openSync(logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      fs.closeSync(fd);
      logOffset = stat.size;
      const lines = buf
        .toString()
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => l.replace(ANSI_RE, ''));
      if (lines.length > 0) postJson(config, '/api/logs/push', { lines });
    } catch {
      /* ignore */
    }
  }, 2000);
}

async function push(config: PusherConfig): Promise<void> {
  const snapshot = collectSnapshot();
  postJson(config, '/api/ingest', snapshot);
  logger.debug('Dashboard snapshot pushed');
}

function safeFolder(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9-]/g, '-');
}

function isGroupJid(jid: string): number {
  return jid.endsWith('@g.us') || jid.includes('_group_') ? 1 : 0;
}

function getRunningContainerNames(): Set<string> {
  try {
    const out = execSync(
      `docker ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
    ).toString();
    return new Set(out.split('\n').filter(Boolean));
  } catch {
    return new Set();
  }
}

function collectSnapshot(): Record<string, unknown> {
  const groups = getAllRegisteredGroups();
  const sessionMap = getAllSessions();
  const running = getRunningContainerNames();

  const agentGroups = collectAgentGroups(groups, sessionMap, running);
  const sessions = collectSessions(groups, sessionMap, running);
  const channels = collectChannels(groups, running);
  const tokens = collectTokens(groups);
  const contextWindows = collectContextWindows(groups, sessionMap);
  const activity = collectActivity();
  const messages = collectMessages(groups);

  return {
    timestamp: new Date().toISOString(),
    assistant_name: ASSISTANT_NAME,
    uptime: Math.floor(process.uptime()),
    agent_groups: agentGroups,
    sessions,
    channels,
    users: [],
    tokens,
    context_windows: contextWindows,
    activity,
    messages,
  };
}

function collectAgentGroups(
  groups: Record<string, ReturnType<typeof getAllRegisteredGroups>[string]>,
  sessionMap: Record<string, string>,
  running: Set<string>,
) {
  return Object.entries(groups).map(([jid, g]) => {
    const hasSession = !!sessionMap[g.folder];
    const prefix = `nanoclaw-${safeFolder(g.folder)}-`;
    const isRunning = [...running].some((n) => n.startsWith(prefix));

    return {
      id: g.folder,
      name: g.name,
      folder: g.folder,
      agent_provider: 'claude',
      container_config: g.containerConfig ?? null,
      sessionCount: hasSession ? 1 : 0,
      runningSessions: isRunning ? 1 : 0,
      wirings: [
        {
          channel_type: channelTypeFromJid(jid),
          platform_id: jid,
          mg_name: g.name,
          is_group: isGroupJid(jid),
          unknown_sender_policy: 'strict',
          priority: 0,
        },
      ],
      destinations: [],
      members: [],
      admins: [],
      created_at: g.added_at,
    };
  });
}

function collectSessions(
  groups: Record<string, ReturnType<typeof getAllRegisteredGroups>[string]>,
  sessionMap: Record<string, string>,
  running: Set<string>,
) {
  const out: Array<Record<string, unknown>> = [];
  for (const [jid, g] of Object.entries(groups)) {
    const sessionId = sessionMap[g.folder];
    if (!sessionId) continue;

    const prefix = `nanoclaw-${safeFolder(g.folder)}-`;
    const containerName = [...running].find((n) => n.startsWith(prefix));
    const containerStatus = containerName ? 'running' : 'stopped';

    const lastActive = lastJsonlMtime(g.folder);

    out.push({
      id: sessionId,
      agent_group_id: g.folder,
      agent_group_name: g.name,
      agent_group_folder: g.folder,
      messaging_group_id: jid,
      messaging_group_name: g.name,
      channel_type: channelTypeFromJid(jid),
      platform_id: jid,
      thread_id: jid,
      status: 'active',
      container_status: containerStatus,
      last_active: lastActive,
      created_at: g.added_at,
    });
  }
  return out;
}

function collectChannels(
  groups: Record<string, ReturnType<typeof getAllRegisteredGroups>[string]>,
  running: Set<string>,
) {
  const registered = getRegisteredChannelNames();
  const byType: Record<
    string,
    {
      channelType: string;
      isLive: boolean;
      isRegistered: boolean;
      groups: Array<Record<string, unknown>>;
    }
  > = {};

  for (const [jid, g] of Object.entries(groups)) {
    const ct = channelTypeFromJid(jid);
    if (!byType[ct]) {
      byType[ct] = {
        channelType: ct,
        isLive: registered.includes(ct),
        isRegistered: registered.includes(ct),
        groups: [],
      };
    }
    byType[ct].groups.push({
      messagingGroup: {
        id: jid,
        platform_id: jid,
        name: g.name,
        is_group: isGroupJid(jid),
        unknown_sender_policy: 'strict',
      },
      agents: [
        {
          agent_group_id: g.folder,
          agent_group_name: g.name,
          priority: 0,
        },
      ],
    });
  }

  // Include registered channels even with no groups
  for (const ct of registered) {
    if (!byType[ct]) {
      byType[ct] = {
        channelType: ct,
        isLive: true,
        isRegistered: true,
        groups: [],
      };
    }
  }

  return Object.values(byType).sort((a, b) =>
    a.channelType.localeCompare(b.channelType),
  );
}

interface TokenEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function scanJsonlTokens(folder: string): TokenEntry[] {
  const claudeDir = path.join(
    DATA_DIR,
    'sessions',
    folder,
    '.claude',
    'projects',
  );
  if (!fs.existsSync(claudeDir)) return [];

  const entries: TokenEntry[] = [];
  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) {
          try {
            for (const line of fs.readFileSync(full, 'utf-8').split('\n')) {
              if (!line.trim()) continue;
              try {
                const r = JSON.parse(line);
                if (r.type === 'assistant' && r.message?.usage) {
                  const u = r.message.usage;
                  entries.push({
                    model: r.message.model || 'unknown',
                    inputTokens: u.input_tokens || 0,
                    outputTokens: u.output_tokens || 0,
                    cacheReadTokens: u.cache_read_input_tokens || 0,
                    cacheCreationTokens: u.cache_creation_input_tokens || 0,
                  });
                }
              } catch {
                /* skip line */
              }
            }
          } catch {
            /* skip file */
          }
        }
      }
    } catch {
      /* skip dir */
    }
  };
  walk(claudeDir);
  return entries;
}

function collectTokens(
  groups: Record<string, ReturnType<typeof getAllRegisteredGroups>[string]>,
) {
  const byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  > = {};
  const byGroup: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      name: string;
    }
  > = {};
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  for (const g of Object.values(groups)) {
    const entries = scanJsonlTokens(g.folder);
    for (const e of entries) {
      if (!byModel[e.model])
        byModel[e.model] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
      byModel[e.model].requests++;
      byModel[e.model].inputTokens += e.inputTokens;
      byModel[e.model].outputTokens += e.outputTokens;
      byModel[e.model].cacheReadTokens += e.cacheReadTokens;
      byModel[e.model].cacheCreationTokens += e.cacheCreationTokens;

      if (!byGroup[g.folder])
        byGroup[g.folder] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          name: g.name,
        };
      byGroup[g.folder].requests++;
      byGroup[g.folder].inputTokens += e.inputTokens;
      byGroup[g.folder].outputTokens += e.outputTokens;
      byGroup[g.folder].cacheReadTokens += e.cacheReadTokens;
      byGroup[g.folder].cacheCreationTokens += e.cacheCreationTokens;

      totals.requests++;
      totals.inputTokens += e.inputTokens;
      totals.outputTokens += e.outputTokens;
      totals.cacheReadTokens += e.cacheReadTokens;
      totals.cacheCreationTokens += e.cacheCreationTokens;
    }
  }

  return { totals, byModel, byGroup };
}

function findJsonlFiles(folder: string): string[] {
  const claudeDir = path.join(
    DATA_DIR,
    'sessions',
    folder,
    '.claude',
    'projects',
  );
  if (!fs.existsSync(claudeDir)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) found.push(full);
      }
    } catch {
      /* skip */
    }
  };
  walk(claudeDir);
  return found;
}

function lastJsonlMtime(folder: string): string | undefined {
  const files = findJsonlFiles(folder);
  if (files.length === 0) return undefined;
  let latest = 0;
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > latest) latest = m;
    } catch {
      /* skip */
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function collectContextWindows(
  groups: Record<string, ReturnType<typeof getAllRegisteredGroups>[string]>,
  sessionMap: Record<string, string>,
) {
  const results: unknown[] = [];

  for (const g of Object.values(groups)) {
    const files = findJsonlFiles(g.folder);
    if (files.length === 0) continue;

    files.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    let content: string;
    try {
      content = fs.readFileSync(files[0], 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const r = JSON.parse(lines[i]);
        if (r.type === 'assistant' && r.message?.usage) {
          const u = r.message.usage;
          const model = r.message.model || 'unknown';
          const ctx =
            (u.input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.cache_creation_input_tokens || 0);
          const max = 200000;
          results.push({
            agentGroupId: g.folder,
            agentGroupName: g.name,
            sessionId:
              sessionMap[g.folder] || path.basename(files[0], '.jsonl'),
            model,
            contextTokens: ctx,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cache_creation_input_tokens || 0,
            maxContext: max,
            usagePercent: max > 0 ? Math.round((ctx / max) * 100) : 0,
            timestamp: r.timestamp || '',
          });
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  return results;
}

function toBucketArray(
  buckets: Record<string, { inbound: number; outbound: number }>,
) {
  return Object.entries(buckets)
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function collectActivity() {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};
  for (let i = 0; i < 24; i++) {
    const key = new Date(now - i * 3600000).toISOString().slice(0, 13);
    buckets[key] = { inbound: 0, outbound: 0 };
  }

  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) return toBucketArray(buckets);

  const cutoff = new Date(now - 86400000).toISOString();

  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT timestamp, is_from_me FROM messages WHERE timestamp > ?`,
      )
      .all(cutoff) as Array<{ timestamp: string; is_from_me: number }>;
    for (const row of rows) {
      const key = row.timestamp.slice(0, 13);
      if (!buckets[key]) continue;
      if (row.is_from_me) buckets[key].outbound++;
      else buckets[key].inbound++;
    }
    db.close();
  } catch {
    /* skip */
  }

  return toBucketArray(buckets);
}

function collectMessages(
  groups: Record<string, ReturnType<typeof getAllRegisteredGroups>[string]>,
) {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) return [];

  const results: Array<{
    agentGroupId: string;
    sessionId: string;
    inbound: unknown[];
    outbound: unknown[];
  }> = [];
  const limit = 50;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const stmt = db.prepare(
      `SELECT id, sender, sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ? AND is_from_me = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    );

    for (const [jid, g] of Object.entries(groups)) {
      const inbound = (stmt.all(jid, 0, limit) as unknown[]).reverse();
      const outbound = (stmt.all(jid, 1, limit) as unknown[]).reverse();
      if (inbound.length > 0 || outbound.length > 0) {
        results.push({
          agentGroupId: g.folder,
          sessionId: g.folder,
          inbound,
          outbound,
        });
      }
    }
  } catch {
    /* skip */
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* skip */
      }
    }
  }

  return results;
}
