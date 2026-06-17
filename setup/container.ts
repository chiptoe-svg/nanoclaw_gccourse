/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 *
 * Supports two runtimes:
 *   apple-container  macOS/Apple Silicon native (default on arm64 macOS)
 *   docker           Linux or macOS with Docker Desktop
 *
 * The runtime is selected by setup/auto.ts and passed as --runtime <name>.
 * It is also written to .env as NANOCLAW_CONTAINER_RUNTIME so the host
 * picks it up at runtime via src/container-runtime.ts.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

// ── runtime types ──────────────────────────────────────────────────────────

type Runtime = 'apple-container' | 'docker';

type DockerStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';

// ── Apple Container helpers ────────────────────────────────────────────────

function appleContainerInstalled(): boolean {
  return commandExists('container');
}

function appleContainerRunning(): boolean {
  return spawnSync('container', ['system', 'status'], { stdio: 'pipe' }).status === 0;
}

function installAppleContainer(): boolean {
  if (!commandExists('brew')) {
    log.warn('Homebrew not found — cannot auto-install Apple Container');
    return false;
  }
  log.info('Installing Apple Container via Homebrew');
  const res = spawnSync('brew', ['install', 'container'], { stdio: 'inherit' });
  return res.status === 0;
}

/**
 * Start Apple Container. First run requires a kernel extension install that
 * prompts for sudo — inherit stdio so the prompt is visible.
 */
function startAppleContainer(): boolean {
  log.info('Starting Apple Container runtime');
  const res = spawnSync('container', ['system', 'start'], { stdio: 'inherit' });
  return res.status === 0;
}

// ── Docker helpers ─────────────────────────────────────────────────────────

function dockerStatus(): DockerStatus {
  const res = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(err)) return 'no-daemon';
  return 'other';
}

function dockerRunning(): boolean {
  return dockerStatus() === 'ok';
}

async function tryStartDocker(): Promise<DockerStatus> {
  const platform = getPlatform();
  log.info('Docker not running — attempting to start', { platform });

  try {
    if (platform === 'macos') {
      execSync('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'linux') {
      execSync('sudo systemctl start docker', { stdio: 'inherit' });
    } else {
      return 'other';
    }
  } catch (err) {
    log.warn('Start command failed', { err });
    return 'other';
  }

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const s = dockerStatus();
    if (s === 'ok') { log.info('Docker is up'); return 'ok'; }
    if (s === 'no-permission') { log.info('Docker up but socket not accessible'); return 'no-permission'; }
  }
  log.warn('Docker did not become ready within 60s');
  return 'no-daemon';
}

// ── arg parsing ────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { runtime: Runtime } {
  let runtime: Runtime = os.platform() === 'darwin' && os.arch() === 'arm64'
    ? 'apple-container'
    : 'docker';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      const val = args[i + 1];
      if (val === 'apple-container' || val === 'docker') {
        runtime = val;
      }
      i++;
    }
  }
  return { runtime };
}

// ── build-arg helpers ──────────────────────────────────────────────────────

function readBuildArgs(projectRoot: string): string[] {
  const buildArgs: string[] = [];
  try {
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg', 'INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env optional on fresh checkout
  }
  return buildArgs;
}

// ── .env persistence ───────────────────────────────────────────────────────

function persistRuntime(projectRoot: string, runtime: Runtime): void {
  const envPath = path.join(projectRoot, '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const key = 'NANOCLAW_CONTAINER_RUNTIME';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${runtime}`;
  const next = re.test(content)
    ? content.replace(re, line)
    : content.trimEnd() + (content ? '\n' : '') + line + '\n';
  fs.writeFileSync(envPath, next);
}

// ── main ───────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);

  log.info('Container step', { runtime, image });

  if (runtime === 'apple-container') {
    await runAppleContainer(projectRoot, image);
  } else {
    await runDocker(projectRoot, image);
  }
}

// ── Apple Container path ───────────────────────────────────────────────────

async function runAppleContainer(projectRoot: string, image: string): Promise<void> {
  if (!appleContainerInstalled()) {
    log.info('Apple Container not found — installing');
    if (!installAppleContainer()) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: 'apple-container',
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  if (!appleContainerRunning()) {
    if (!startAppleContainer()) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: 'apple-container',
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  persistRuntime(projectRoot, 'apple-container');

  const buildArgs = readBuildArgs(projectRoot);

  log.info('Building container image', { runtime: 'apple-container', image });
  const buildRes = spawnSync(
    'container',
    ['build', ...buildArgs, '-t', image, '.'],
    { cwd: path.join(projectRoot, 'container'), stdio: 'inherit' },
  );
  const buildOk = buildRes.status === 0;
  if (buildOk) {
    log.info('Container build succeeded');
  } else {
    log.error('Container build failed', { exitCode: buildRes.status });
  }

  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    const testRes = spawnSync(
      'container',
      ['run', '--rm', '--entrypoint', '/bin/echo', image, 'Container OK'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    testOk = testRes.status === 0 && (testRes.stdout ?? '').includes('Container OK');
    log.info('Container test result', { testOk });
  }

  const status = buildOk && testOk ? 'success' : 'failed';
  emitStatus('SETUP_CONTAINER', {
    RUNTIME: 'apple-container',
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });
  if (status === 'failed') process.exit(1);
}

// ── Docker path ────────────────────────────────────────────────────────────

async function runDocker(projectRoot: string, image: string): Promise<void> {
  if (!commandExists('docker')) {
    log.info('Docker not found — running setup/install-docker.sh');
    try {
      execSync('bash setup/install-docker.sh', { cwd: projectRoot, stdio: 'inherit' });
    } catch (err) {
      log.warn('install-docker.sh failed', { err });
    }
  }

  if (!commandExists('docker')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: 'docker',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  {
    let status = dockerStatus();
    if (status !== 'ok') status = await tryStartDocker();

    if (status === 'no-permission' && getPlatform() === 'linux' && commandExists('sg')) {
      const inGroup = spawnSync('id', ['-nG'], { encoding: 'utf-8' });
      if (!(inGroup.stdout ?? '').split(/\s+/).includes('docker')) {
        log.info('Adding current user to docker group');
        spawnSync('sudo', ['usermod', '-aG', 'docker', process.env.USER ?? ''], { stdio: 'inherit' });
      }
      log.info('Re-executing container step under `sg docker`');
      const res = spawnSync(
        'sg',
        ['docker', '-c', 'pnpm exec tsx setup/index.ts --step container'],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      process.exit(res.status ?? 1);
    }

    if (status !== 'ok') {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: 'docker',
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: status === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  persistRuntime(projectRoot, 'docker');

  const buildArgs = readBuildArgs(projectRoot);

  log.info('Building container image', { runtime: 'docker', image });
  const buildRes = spawnSync(
    'docker',
    ['build', ...buildArgs, '-t', image, '.'],
    { cwd: path.join(projectRoot, 'container'), stdio: 'inherit' },
  );
  const buildOk = buildRes.status === 0;
  if (buildOk) {
    log.info('Container build succeeded');
  } else {
    log.error('Container build failed', { exitCode: buildRes.status });
  }

  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    const testRes = spawnSync(
      'docker',
      ['run', '-i', '--rm', '--entrypoint', '/bin/echo', image, 'Container OK'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    testOk = testRes.status === 0 && (testRes.stdout ?? '').includes('Container OK');
    log.info('Container test result', { testOk });
  }

  const status = buildOk && testOk ? 'success' : 'failed';
  emitStatus('SETUP_CONTAINER', {
    RUNTIME: 'docker',
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });
  if (status === 'failed') process.exit(1);
}
