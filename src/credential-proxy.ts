/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth token source (in order of priority):
 *   1. CLAUDE_CODE_OAUTH_TOKEN in .env (static, user-managed)
 *   2. ~/.claude/.credentials.json (auto-refreshed by Claude CLI)
 */
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

const CLAUDE_CREDENTIALS_PATH = path.join(
  process.env.HOME || '/home/node',
  '.claude',
  '.credentials.json',
);

// Buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedOAuthToken: string | null = null;
let cachedExpiresAt = 0;

/**
 * Read the OAuth access token, preferring .env but falling back to
 * Claude CLI's credentials file. Returns null if neither is available.
 */
function getOAuthToken(envToken?: string): string | null {
  // Static token from .env always wins
  if (envToken) return envToken;

  // Check if cached token is still valid
  if (cachedOAuthToken && Date.now() < cachedExpiresAt - REFRESH_BUFFER_MS) {
    return cachedOAuthToken;
  }

  // Read from Claude CLI credentials
  try {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return null;
    const creds: ClaudeCredentials = JSON.parse(
      fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'),
    );
    if (!creds.claudeAiOauth?.accessToken) return null;

    cachedOAuthToken = creds.claudeAiOauth.accessToken;
    cachedExpiresAt = creds.claudeAiOauth.expiresAt;

    const expiresIn = Math.round(
      (cachedExpiresAt - Date.now()) / 1000 / 60 / 60,
    );
    log.debug('Loaded OAuth token from Claude CLI credentials', {
      expiresInHours: expiresIn,
    });

    return cachedOAuthToken;
  } catch (err) {
    log.warn('Failed to read Claude CLI credentials', { err });
    return null;
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOAuthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const anthropicUpstream = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const openaiUpstream = new URL(
    secrets.OPENAI_BASE_URL || 'https://api.openai.com',
  );

  const requestFor = (isHttps: boolean) =>
    isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Route by path prefix:
        //   /openai/*  → OpenAI (strip prefix, inject Authorization)
        //   everything else → Anthropic (existing behaviour)
        const rawUrl = req.url || '/';
        const isOpenAI = rawUrl.startsWith('/openai/') || rawUrl === '/openai';

        const upstreamUrl = isOpenAI ? openaiUpstream : anthropicUpstream;
        const upstreamPath = isOpenAI
          ? rawUrl.replace(/^\/openai/, '') || '/'
          : rawUrl;
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = requestFor(isHttps);

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (isOpenAI) {
          // OpenAI mode: replace any placeholder Authorization with the
          // real key. If OPENAI_API_KEY isn't set on the host, 502 with
          // a clear message so the container-side error is actionable.
          if (!secrets.OPENAI_API_KEY) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message:
                    'OPENAI_API_KEY is not set on the host. Add it to .env and restart nanoclaw.',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
        } else if (authMode === 'api-key') {
          // Anthropic API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // Anthropic OAuth mode: replace placeholder Bearer token with
          // the real one only when the container actually sends an
          // Authorization header (exchange request + auth probes).
          // Post-exchange requests use x-api-key only, so they pass
          // through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = getOAuthToken(envOAuthToken);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', {
            err,
            url: req.url,
            isOpenAI,
          });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
