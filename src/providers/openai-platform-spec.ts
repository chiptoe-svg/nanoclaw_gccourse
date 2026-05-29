import type { ModelEntry } from '../model-catalog.js';
import { registerProvider } from './auth-registry.js';
import { OPENAI_CATALOG } from './openai-catalog.js';

registerProvider({
  id: 'openai-platform',
  displayName: 'OpenAI API',
  proxyRoutePrefix: '/openai-platform/',
  credentialFileShape: 'api-key',
  apiKey: {
    placeholder: 'sk-…',
    validatePrefix: 'sk-',
  },
  // Catalog mirrors codex-spec's lineup verbatim: user's empirical observation
  // is "the OpenAI Platform API offers everything the ChatGPT subscription
  // does." Same model IDs, same costs (codex-spec's costs are per-token rates
  // from OpenAI's API pricing docs and apply to both routing paths). The
  // distinction between the two providers is therefore the AUTH method
  // (subscription OAuth vs API key) + the upstream endpoint
  // (backend-api.openai.com vs api.openai.com), NOT the model menu.
  //
  // If a model ID returns 404 when invoked via api.openai.com (i.e. the
  // empirical assumption is wrong for that specific model), drop it from
  // this catalog and surface the gap in state.md.
  // Catalog comes from the shared OPENAI_CATALOG — same lineup as
  // codex-spec.ts. Tagged with the openai-platform modelProvider name
  // since that's what container_configs.model_provider stores when an
  // agent routes through the Platform API key path.
  catalogModels: OPENAI_CATALOG.map((m) => ({ ...m, modelProvider: 'openai-platform' })) satisfies ModelEntry[],
});
