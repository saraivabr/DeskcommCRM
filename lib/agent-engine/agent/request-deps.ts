import { previewFixtureRegistry } from './preview-fixture';
import { productionRequestTurnDeps } from './production-request-deps';
import type { InboundTurnDeps } from './inbound-turn';
export function requestTurnDeps(): InboundTurnDeps {
  const deps = productionRequestTurnDeps();
  const fixture = process.env.INTERNAL_AGENT_RUN_STUB === 'true';
  const llmCfg = deps.llmCfg;
  if (fixture) llmCfg.anthropicApiKey = 'local-controlled-provider';
  return {
    ...deps,
    ...(fixture
      ? {
          registry: previewFixtureRegistry(),
          embed: async () => ({
            embedding: Array(1536).fill(0.1),
            promptTokens: 0,
            model: 'text-embedding-3-small',
          }),
        }
      : {}),
    llmCfg,
  };
}
