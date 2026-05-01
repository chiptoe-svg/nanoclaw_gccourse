/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Env passthrough is deliberately narrow:
 *   CODEX_MODEL — model override the runner reads to pick the codex model.
 *
 * NOT passed through:
 *   OPENAI_API_KEY  — would override the credential-proxy `placeholder` and
 *     leak the real key into container env. The proxy substitutes the real
 *     key on every request based on the placeholder, so the container
 *     never needs to see it.
 *   OPENAI_BASE_URL — would override the proxy URL we set in
 *     container-runner.ts. Containers must route through the proxy.
 *
 * For Codex with ChatGPT subscription auth (the common path), the OAuth
 * token in `auth.json` is the credential — neither OPENAI_API_KEY nor
 * the proxy is involved on that codepath.
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy the host's auth.json into the per-session dir if it exists.
  // We only copy auth.json, not the full ~/.codex — config.toml would
  // get clobbered by the container on every wake anyway.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
  }

  const env: Record<string, string> = {};
  if (ctx.hostEnv.CODEX_MODEL) env.CODEX_MODEL = ctx.hostEnv.CODEX_MODEL;

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
