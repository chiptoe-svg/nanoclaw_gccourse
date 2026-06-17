/**
 * OpenAI Codex adapter for the setup-helper registry.
 *
 * Headless: `codex exec "<prompt>"` — non-interactive subcommand,
 * prints the agent's reply to stdout.
 * Handoff:  `codex "<prompt>"` — bare `codex [PROMPT]` opens the
 * interactive TUI with the prompt as the opening message.
 *
 * Auth probe: codex doesn't expose a non-network `auth status` we can
 * probe in <1s. Treat as `undefined` — setup will proceed and let
 * actual usage surface the error if auth is broken.
 *
 * Install: codex has no scriptable installer in this fork yet (the
 * upstream `/add-codex` skill installs it via pnpm global). Returning
 * `null` for installScript means setup tells the user to install
 * manually rather than trying to auto-install.
 */
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HeadlessOpts, SpawnArgs, AiCodingCli } from './types.js';

function isInstalled(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isAuthenticated(): boolean | undefined {
  if (!isInstalled()) return false;
  // codex has no fast offline auth-probe; we let actual invocation surface
  // the error rather than block setup on a network round-trip.
  return undefined;
}

function headless(prompt: string, _opts: HeadlessOpts = {}): SpawnArgs {
  // `codex exec` already permits tool use in its sandbox; opts.tools is
  // accepted for API uniformity but doesn't change the argv.
  return {
    args: ['exec', prompt],
    stdin: 'ignore',
    output: 'pipe',
  };
}

function handoff(prompt: string): SpawnArgs {
  return {
    args: [prompt],
    stdin: 'inherit',
    output: 'inherit',
  };
}

/**
 * Wire nanoclaw's project skills into ~/.codex/skills/ and add the
 * codegraph MCP server to ~/.codex/config.toml.
 *
 * Skills: per-file symlinks from ~/.codex/skills/<name> → <projectRoot>/.claude/skills/<name>.
 * Per-file (not a directory symlink) so skills a Codex user adds land in
 * ~/.codex/skills/ directly rather than flowing back into .claude/skills/.
 *
 * CodeGraph: appends [mcp_servers.codegraph] only if the codegraph binary
 * is on PATH and the section is not already present.
 *
 * Both operations are idempotent.
 */
function prepareEnvironment(projectRoot: string): void {
  const codexSkillsDir = path.join(os.homedir(), '.codex', 'skills');
  const nanoclaWSkillsDir = path.join(projectRoot, '.claude', 'skills');

  if (fs.existsSync(nanoclaWSkillsDir)) {
    fs.mkdirSync(codexSkillsDir, { recursive: true });
    for (const entry of fs.readdirSync(nanoclaWSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = path.join(codexSkillsDir, entry.name);
      if (fs.existsSync(dest)) continue;
      fs.symlinkSync(path.join(nanoclaWSkillsDir, entry.name), dest);
    }
  }

  const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
  let hasCodegraph = false;
  if (fs.existsSync(codexConfigPath)) {
    hasCodegraph = fs.readFileSync(codexConfigPath, 'utf-8').includes('[mcp_servers.codegraph]');
  }
  if (!hasCodegraph) {
    const probe = spawnSync('which', ['codegraph'], { stdio: 'ignore' });
    if (probe.status === 0) {
      const block = '\n[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp"]\n';
      fs.appendFileSync(codexConfigPath, block);
    }
    // codegraph not installed — skip; user can add it later
  }
}

export const codexCli: AiCodingCli = {
  name: 'codex',
  displayName: 'OpenAI Codex',
  binary: 'codex',
  isInstalled,
  isAuthenticated,
  installScript: null,
  headless,
  handoff,
  prepareEnvironment,
};
