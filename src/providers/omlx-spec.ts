import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';

const OMLX_BASE_URL = process.env.OMLX_BASE_URL || 'http://localhost:8000';

async function probeReachability(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${OMLX_BASE_URL}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

registerProvider({
  id: 'omlx',
  displayName: 'OMLX (local server)',
  proxyRoutePrefix: '/omlx/',
  credentialFileShape: 'none',
  catalogModels: [
    {
      id: 'Qwen3.6-35B-A3B-UD-MLX-4bit',
      modelProvider: 'local',
      displayName: 'Qwen 3.6 (35B, MLX 4-bit)',
      origin: 'local',
      costPer1kTokensUsd: 0,
      avgLatencySec: 8,
      paramCount: '35B',
      modalities: ['text', 'image'],
      notes: 'Runs on the host Mac. Free, no quota — but slower than cloud.',
      host: OMLX_BASE_URL,
      contextSize: 32768,
      quantization: 'MLX 4-bit',
      chips: ['🆓 free', '💻 mlx local', '🐢 slower'],
      bestFor: 'Comparing local vs cloud cost/latency tradeoffs.',
      default: true,
    },
  ] satisfies ModelEntry[],
  reachability: probeReachability,
});
