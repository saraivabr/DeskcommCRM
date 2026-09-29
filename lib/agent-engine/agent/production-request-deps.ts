import { loadEnv } from "../env";
import { crmEdgeConfigFromEnv } from "../edge/crm/mcp-client";
import { llmEdgeConfigFromEnv } from "../edge/llm/run-model-call";
import { createLogger } from "../obs/logger";
import { turnKnobsFromEnv } from "./turn-knobs";
import type { InboundTurnDeps } from "./inbound-turn";

/** Dependencies for live requests; controlled preview data stays outside this graph. */
export function productionRequestTurnDeps(): InboundTurnDeps {
  const env = loadEnv();
  return {
    crmCfg: crmEdgeConfigFromEnv({
      SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    }),
    llmCfg: llmEdgeConfigFromEnv(env),
    knobs: turnKnobsFromEnv(env),
    log: createLogger(),
  };
}
