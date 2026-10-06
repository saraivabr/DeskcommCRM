import { randomUUID } from "node:crypto";
import {
  MetaOperationStore,
  resolveSelectedMetaAsset,
  createMetaExecutionContext,
  MetaExecutionInterrupted,
} from "@/lib/channels/meta/social/operations";
import { executeNativeInstagramOperation } from "@/lib/channels/meta/social/publish";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createBoundedMetaAdminClient } from "@/lib/channels/meta/social/bounded-admin";
import { queryMetaMedia, withMetaMediaLock } from "@/lib/channels/meta/social/media-lock";

export const META_OPERATION_CONSUMER = "meta-native-operation-v1";
/** Bounded maintenance clears unused encrypted callback results after expiry. */
export async function expireMetaOAuthAttempts(store = new MetaOperationStore()): Promise<number> {
  const { data, error } = await store.db.rpc("fn_meta_expire_oauth", { p_limit: 200 });
  if (error || typeof data !== "number" || !Number.isSafeInteger(data) || data < 0)
    throw new MetaIntegrationError(
      "meta_store_unavailable",
      "Não foi possível expirar autorizações pendentes.",
    );
  return data;
}
/** Recover provisional rows left by a crash before the atomic operation reservation. */
export async function pruneUnreservedMetaPublications(): Promise<number> {
  const { getRequestPool } = await import("@/lib/agent-engine/db/request-pool");
  const pool = getRequestPool();
  const result = await pool.query<{
    organization_id: string;
    id: string;
    meta_connection_id: string;
  }>(
    `select organization_id,id,meta_connection_id from public.instagram_publications
      where provider='meta' and status='preparing' and operation_id is null
        and created_at < now()-interval '10 minutes'
        and not meta_media_cleanup_uncertain
      order by created_at limit 10`,
  );
  let removed = 0;
  const db = createBoundedMetaAdminClient();
  for (const publication of result.rows) {
    if (!publication.meta_connection_id) continue;
    try {
      removed += await withMetaMediaLock(publication.meta_connection_id, false, async (client) => {
        const stillPreparing = await queryMetaMedia(
          client,
          `select id from instagram_publications where organization_id=$1 and id=$2
           and provider='meta' and status='preparing' and operation_id is null
           and not meta_media_cleanup_uncertain`,
          [publication.organization_id, publication.id],
        );
        if (!stillPreparing.rowCount) return 0;
        const paths = Array.from(
          { length: 10 },
          (_, index) =>
            `${publication.organization_id}/instagram/publications/${publication.id}/${index}.jpg`,
        );
        const storage = await db.storage.from("whatsapp-media").remove(paths);
        if (storage.error)
          throw new MetaIntegrationError("meta_store_unavailable", "Limpeza de mídia pendente.");
        const deleted = await queryMetaMedia(
          client,
          `delete from instagram_publications where organization_id=$1 and id=$2
           and provider='meta' and status='preparing' and operation_id is null
           and not meta_media_cleanup_uncertain returning id`,
          [publication.organization_id, publication.id],
        );
        return deleted.rowCount ?? 0;
      });
    } catch (error) {
      if (error instanceof MetaIntegrationError && error.code === "meta_preparation_busy") continue;
      throw error;
    }
  }
  return removed;
}
export async function executeMetaOperation(
  organizationId: string,
  operationId: string,
  store = new MetaOperationStore(),
): Promise<void> {
  const operation = await store.claim(organizationId, operationId, `meta:${randomUUID()}`);
  if (!operation) return;
  try {
    const resolved = await resolveSelectedMetaAsset(
      organizationId,
      operation.asset_id,
      operation.kind === "instagram_publish" ? "instagram_publish" : "ads_manage",
      operation.connection_id,
      store.db,
    );
    const context = createMetaExecutionContext(operation, resolved, store);
    if (operation.kind === "instagram_publish") await executeNativeInstagramOperation(context);
    else if (operation.kind === "ads_create") {
      const { executeNativeAdsOperation } =
        await import("@/lib/plataformas-de-anuncio/meta/native-operations");
      await executeNativeAdsOperation(context);
    } else
      await context.checkpoint({
        status: "blocked",
        errorCode: "meta_operation_unsupported",
        errorMessage: "Esta operação ainda não está disponível.",
      });
  } catch (e) {
    if (e instanceof MetaExecutionInterrupted || operation.status !== "executing") return;
    const code = e instanceof MetaIntegrationError ? e.code : "meta_operation_failed";
    // Read transport/storage failures are safe to resume only after the last known checkpoint.
    const transient = [
      "meta_provider_unavailable",
      "meta_provider_response_invalid",
      "meta_store_unavailable",
      "meta_media_unavailable",
    ].includes(code);
    const count = Number(operation.external_ids.read_failures ?? 0) + 1;
    await store.checkpoint(operation, {
      status:
        transient && count < 5
          ? "awaiting_provider"
          : code.includes("authorization") || code.includes("denied") || code.includes("lease")
            ? "blocked"
            : "failed",
      externalIds: { read_failures: count },
      errorCode: code,
      errorMessage:
        e instanceof MetaIntegrationError
          ? e.message
          : "Não foi possível concluir esta operação. Confira o resultado antes de continuar.",
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
}
export async function handleMetaOperation(row: EventRow): Promise<HandlerResult> {
  const id = row.payload.operation_id;
  if (typeof id !== "string" || id !== row.entity_id || row.entity_kind !== "meta_operation")
    return {
      consumer_key: META_OPERATION_CONSUMER,
      status: "skipped",
      detail: "invalid operation pointer",
    };
  await executeMetaOperation(row.organization_id, id);
  return { consumer_key: META_OPERATION_CONSUMER, status: "ok" };
}
/** Pending containers and expired leases progress even after their wake-up event is consumed. */
export async function drainDueMetaOperations(store = new MetaOperationStore()): Promise<number> {
  const now = new Date().toISOString();
  const { data, error } = await store.db
    .from("meta_operations")
    .select("id,organization_id")
    .or(
      `and(status.in.(queued,awaiting_provider),retry_at.lte.${now}),and(status.eq.executing,lease_until.lte.${now})`,
    )
    .order("retry_at")
    .limit(10);
  if (error)
    throw new MetaIntegrationError(
      "meta_store_unavailable",
      "Não foi possível retomar as operações Meta.",
    );
  for (const op of data ?? []) await executeMetaOperation(op.organization_id, op.id, store);
  return data?.length ?? 0;
}
