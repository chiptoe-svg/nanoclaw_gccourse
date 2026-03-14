/**
 * Auth mode switching for NanoClaw.
 * Toggles between API key and OAuth by editing .env comments.
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

const ENV_PATH = path.join(process.cwd(), '.env');

/**
 * Detect current auth mode from .env file.
 * An uncommented ANTHROPIC_API_KEY means api-key mode.
 * An uncommented CLAUDE_CODE_OAUTH_TOKEN means oauth mode.
 */
export function getCurrentAuthMode(): AuthMode {
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');

  let hasApiKey = false;
  let hasOauth = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('ANTHROPIC_API_KEY=')) hasApiKey = true;
    if (trimmed.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')) hasOauth = true;
  }

  return hasApiKey ? 'api-key' : hasOauth ? 'oauth' : 'api-key';
}

/**
 * Switch auth mode by commenting/uncommenting lines in .env.
 * Returns the new mode.
 */
export function switchAuthMode(target: AuthMode): AuthMode {
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (target === 'oauth') {
      // Comment out API key, uncomment OAuth token
      if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
        result.push('#' + line);
      } else if (trimmed === '#CLAUDE_CODE_OAUTH_TOKEN=' || trimmed.startsWith('#CLAUDE_CODE_OAUTH_TOKEN=')) {
        result.push(line.replace(/^(\s*)#/, '$1'));
      } else {
        result.push(line);
      }
    } else {
      // Comment out OAuth token, uncomment API key
      if (trimmed.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')) {
        result.push('#' + line);
      } else if (trimmed === '#ANTHROPIC_API_KEY=' || trimmed.startsWith('#ANTHROPIC_API_KEY=')) {
        result.push(line.replace(/^(\s*)#/, '$1'));
      } else {
        result.push(line);
      }
    }
  }

  fs.writeFileSync(ENV_PATH, result.join('\n'));
  logger.info({ target }, 'Auth mode switched');
  return target;
}
