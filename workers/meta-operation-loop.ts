import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** Dynamic imports keep optional web configuration from crashing the agent worker. */
export async function runMetaOperationLoop(log: Logger, signal: AbortSignal): Promise<void> {
  let drain: () => Promise<number>;
  let expire: () => Promise<number>;
  let prune: () => Promise<number>;
  let erase: () => Promise<number>;
  try {
    const { drainDueMetaOperations, expireMetaOAuthAttempts, pruneUnreservedMetaPublications } =
      await import("./meta-operation-worker");
    drain = drainDueMetaOperations;
    expire = expireMetaOAuthAttempts;
    prune = pruneUnreservedMetaPublications;
    const { drainMetaPrivacyRequests } = await import("@/lib/channels/meta/social/removal");
    erase = drainMetaPrivacyRequests;
    log.info("meta operations: laço carregado");
  } catch {
    log.error("meta operations OFF — falha ao carregar dependências");
    return;
  }
  while (!signal.aborted) {
    try {
      await erase();
    } catch {
      log.error("meta privacy: limpeza pendente; nova tentativa em 30 segundos");
    }
    try {
      await expire();
      await prune();
      await drain();
    } catch {
      log.error("meta operations: falha ao retomar operações; nova tentativa em 30 segundos");
    }
    await sleep(30_000, undefined, { signal }).catch(() => undefined);
  }
}
