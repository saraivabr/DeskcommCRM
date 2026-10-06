import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPlatformMetaAppNative } from "@/lib/channels/meta/app";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { MetaConnectionStore } from "./store";
import { assetCapabilities, tokenExpired } from "./capabilities";
import { MetaGraphClient } from "./graph";
import { MetaIntegrationError, metaAssetKindSchema } from "./types";

type Admin = ReturnType<typeof createAdminClient>;
const assetSchema = z.object({
  id: z.uuid(),
  kind: metaAssetKindSchema,
  external_id: z.string(),
  name: z.string(),
  parent_page_id: z.uuid().nullable(),
  currency: z.string().nullable(),
  timezone: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
const grantSchema = z.object({
  id: z.uuid(),
  connection_id: z.uuid(),
  asset_id: z.uuid(),
  selected: z.boolean(),
  status: z.string(),
  tasks: z.array(z.string()),
  permissions: z.array(z.string()),
  page_access_token_encrypted: z.string().nullable(),
});
export type MetaAssetCapability = "ads_read" | "ads_manage" | "instagram_publish";
export interface ResolvedMetaAsset {
  app: Awaited<ReturnType<typeof getPlatformMetaAppNative>>;
  connectionId: string;
  authorizationVersion: number;
  grantId: string;
  asset: z.infer<typeof assetSchema> & { parent_page_external_id: string | null };
  /** Only server-side; never spread this object into an API response. */
  token: string;
}
function unavailable(code = "meta_operation_not_authorized", status = 409): MetaIntegrationError {
  return new MetaIntegrationError(
    code,
    "A autorização deste ativo mudou. Confira a conexão antes de continuar.",
    status,
  );
}
function dbFailure(): MetaIntegrationError {
  return new MetaIntegrationError(
    "meta_store_unavailable",
    "Não foi possível consultar a operação Meta.",
  );
}

/** Resolves an explicitly selected tenant asset through its current grant. */
export async function resolveSelectedMetaAsset(
  organizationId: string,
  assetId: string,
  capability: MetaAssetCapability,
  connectionId?: string,
  db: Admin = createAdminClient(),
): Promise<ResolvedMetaAsset> {
  const app = await getPlatformMetaAppNative();
  if (!app.nativeEnabled || !app.appId || !app.appSecret) throw unavailable();
  const { data: rawAsset, error: assetError } = await db
    .from("meta_assets")
    .select("id,kind,external_id,name,parent_page_id,currency,timezone,metadata")
    .eq("organization_id", organizationId)
    .eq("id", assetId)
    .maybeSingle();
  if (assetError) throw dbFailure();
  const asset = assetSchema.safeParse(rawAsset);
  if (!asset.success) throw unavailable("meta_asset_not_found", 404);
  let query = db
    .from("meta_asset_grants")
    .select(
      "id,connection_id,asset_id,selected,status,tasks,permissions,page_access_token_encrypted",
    )
    .eq("organization_id", organizationId)
    .eq("asset_id", assetId)
    .eq("selected", true)
    .eq("status", "healthy");
  if (connectionId) query = query.eq("connection_id", connectionId);
  const { data: grants, error: grantError } = await query;
  if (grantError) throw dbFailure();
  if (!grants?.length) throw unavailable();
  // Multiple authorizations require the caller to choose a connection, never an arbitrary token.
  if (grants.length !== 1) throw unavailable("meta_connection_ambiguous");
  const grant = grantSchema.parse(grants[0]);
  if (
    !grant.selected ||
    grant.status !== "healthy" ||
    grant.asset_id !== assetId ||
    (connectionId && grant.connection_id !== connectionId)
  )
    throw unavailable();
  const store = new MetaConnectionStore(db);
  const connection = await store.connection(organizationId, grant.connection_id);
  if (
    connection.status !== "healthy" ||
    connection.app_id !== app.appId ||
    tokenExpired(connection.token_expires_at, connection.data_access_expires_at)
  )
    throw unavailable();
  let parentExternalId: string | null = null;
  if (asset.data.parent_page_id) {
    const { data: parent, error } = await db
      .from("meta_assets")
      .select("external_id")
      .eq("organization_id", organizationId)
      .eq("id", asset.data.parent_page_id)
      .eq("kind", "page")
      .maybeSingle();
    if (error) throw dbFailure();
    parentExternalId = parent?.external_id ?? null;
  }
  const capabilities = assetCapabilities({
    app,
    kind: asset.data.kind,
    externalId: asset.data.external_id,
    parentPageExternalId: parentExternalId,
    scopes: connection.scopes,
    permissions: grant.permissions,
    granularScopes: connection.granular_scopes,
    tasks: grant.tasks,
    active: true,
    accountStatus:
      typeof asset.data.metadata.account_status === "number"
        ? asset.data.metadata.account_status
        : undefined,
  });
  if (!capabilities.capabilities[capability]) throw unavailable();
  let token: string;
  if (capability === "instagram_publish") {
    // Facebook Login publishing uses the Page token for this Instagram account's parent Page.
    const { data: parentGrant, error } = await db
      .from("meta_asset_grants")
      .select("page_access_token_encrypted,status")
      .eq("organization_id", organizationId)
      .eq("connection_id", connection.id)
      .eq("asset_id", asset.data.parent_page_id!)
      .eq("status", "healthy")
      .maybeSingle();
    if (error) throw dbFailure();
    if (!parentGrant?.page_access_token_encrypted) throw unavailable();
    const clear = await decryptWebhookSecret(db, parentGrant.page_access_token_encrypted);
    if (!clear) throw unavailable();
    token = clear;
  } else token = await store.token(connection);
  return {
    app,
    connectionId: connection.id,
    authorizationVersion: connection.version,
    grantId: grant.id,
    asset: { ...asset.data, parent_page_external_id: parentExternalId },
    token,
  };
}
export const resolveMetaAsset = resolveSelectedMetaAsset;

export const operationStatusSchema = z.enum([
  "queued",
  "executing",
  "awaiting_provider",
  "succeeded",
  "failed",
  "uncertain",
  "blocked",
  "cancelled",
]);
export const metaOperationSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  actor_id: z.uuid(),
  connection_id: z.uuid(),
  asset_id: z.uuid(),
  grant_id: z.uuid(),
  authorization_version: z.number(),
  kind: z.string(),
  operation_key: z.string(),
  request_hash: z.string(),
  request_payload: z.record(z.string(), z.unknown()),
  status: operationStatusSchema,
  stage: z.string(),
  external_ids: z.record(z.string(), z.unknown()),
  receipt: z.record(z.string(), z.unknown()).nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  lease_owner: z.string().nullable(),
  lease_until: z.string().nullable(),
  fence: z.number(),
  external_dispatch_started_at: z.string().nullable(),
  retry_at: z.string(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type MetaOperation = z.infer<typeof metaOperationSchema>;
export type MetaOperationCheckpoint = {
  status:
    | "executing"
    | "awaiting_provider"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "blocked"
    | "cancelled";
  stage?: string;
  externalIds?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retryAt?: string;
};
export function canonicalMetaJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalMetaJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonicalMetaJSON(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function metaOperationDTO(operation: MetaOperation) {
  const receipt: Record<string, string | null> = {};
  for (const key of [
    "media_id",
    "provider_post_id",
    "permalink",
    "campaign_id",
    "adset_id",
    "ad_set_id",
    "creative_id",
    "ad_id",
    "image_hash",
    "status",
  ]) {
    const value = operation.receipt?.[key];
    if (value === null || typeof value === "string") receipt[key] = value;
  }
  // Payload, grant identities, signed media URLs and encrypted credentials stay internal.
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    stage: operation.stage,
    receipt: operation.receipt ? receipt : null,
    error_code: operation.error_code,
    error_message: operation.error_message,
    created_at: operation.created_at,
    completed_at: operation.completed_at,
  };
}
export class MetaOperationStore {
  constructor(readonly db: Admin = createAdminClient()) {}
  async reserve(input: {
    organizationId: string;
    actorId: string;
    connectionId: string;
    assetId: string;
    grantId: string;
    authorizationVersion: number;
    kind: string;
    operationKey: string;
    payload: Record<string, unknown>;
  }): Promise<{ operation: MetaOperation; replay: boolean }> {
    const requestHash = createHash("sha256").update(canonicalMetaJSON(input.payload)).digest("hex");
    const { data, error } = await this.db.rpc("fn_meta_operation_reserve", {
      p_organization_id: input.organizationId,
      p_actor_id: input.actorId,
      p_connection_id: input.connectionId,
      p_asset_id: input.assetId,
      p_grant_id: input.grantId,
      p_authorization_version: input.authorizationVersion,
      p_kind: input.kind,
      p_operation_key: input.operationKey,
      p_request_hash: requestHash,
      p_request_payload: input.payload as never,
    });
    if (error) {
      if (error.code === "PT409") throw unavailable("meta_idempotency_conflict");
      if (["42501", "PT403"].includes(error.code ?? "")) throw unavailable();
      throw dbFailure();
    }
    const parsed = z
      .object({ operation: metaOperationSchema, replay: z.boolean() })
      .safeParse(data);
    if (!parsed.success) throw dbFailure();
    return parsed.data;
  }
  async get(organizationId: string, operationId: string): Promise<MetaOperation | null> {
    const { data, error } = await this.db
      .from("meta_operations")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("id", operationId)
      .maybeSingle();
    if (error) throw dbFailure();
    const operation = data ? metaOperationSchema.parse(data) : null;
    if (operation && operation.organization_id !== organizationId) throw unavailable();
    return operation;
  }
  async claim(
    organizationId: string,
    operationId: string,
    workerId: string,
  ): Promise<MetaOperation | null> {
    if (!(await this.get(organizationId, operationId))) return null;
    const { data, error } = await this.db.rpc("fn_meta_operation_claim", {
      p_operation_id: operationId,
      p_worker_id: workerId,
      p_lease_seconds: 90,
    });
    if (error) throw dbFailure();
    const operation = data ? metaOperationSchema.parse(data) : null;
    if (operation && operation.organization_id !== organizationId) throw unavailable();
    return operation;
  }
  async authorized(operation: MetaOperation): Promise<boolean> {
    const { data, error } = await this.db.rpc("fn_meta_operation_authorized", {
      p_operation_id: operation.id,
    });
    if (error) throw dbFailure();
    return data === true;
  }
  async heartbeat(operation: MetaOperation): Promise<void> {
    const { data, error } = await this.db.rpc("fn_meta_operation_heartbeat", {
      p_organization_id: operation.organization_id,
      p_operation_id: operation.id,
      p_worker_id: operation.lease_owner!,
      p_fence: operation.fence,
      p_lease_seconds: 90,
    });
    if (error) throw dbFailure();
    if (data !== true) throw unavailable("meta_lease_lost");
  }
  async beginDispatch(operation: MetaOperation): Promise<void> {
    const { data, error } = await this.db.rpc("fn_meta_operation_begin_dispatch", {
      p_organization_id: operation.organization_id,
      p_operation_id: operation.id,
      p_worker_id: operation.lease_owner!,
      p_fence: operation.fence,
    });
    if (error) throw dbFailure();
    if (data !== true) throw unavailable("meta_dispatch_denied");
  }
  async checkpoint(operation: MetaOperation, input: MetaOperationCheckpoint): Promise<void> {
    const { data, error } = await this.db.rpc("fn_meta_operation_checkpoint", {
      p_organization_id: operation.organization_id,
      p_operation_id: operation.id,
      p_worker_id: operation.lease_owner!,
      p_fence: operation.fence,
      p_status: input.status,
      p_stage: input.stage ?? operation.stage,
      p_external_ids: (input.externalIds ?? {}) as never,
      p_receipt: (input.receipt ?? null) as never,
      p_error_code: input.errorCode ?? null,
      p_error_message: input.errorMessage ?? null,
      p_retry_at: input.retryAt ?? (null as never),
    });
    if (error) throw dbFailure();
    if (data !== true) throw unavailable("meta_lease_lost");
    operation.status = input.status;
    operation.stage = input.stage ?? operation.stage;
    operation.external_ids = { ...operation.external_ids, ...input.externalIds };
    operation.receipt = input.receipt ?? operation.receipt;
    void audit({
      action: "meta.operation_checkpointed",
      actorUserId: operation.actor_id,
      organizationId: operation.organization_id,
      resourceType: "meta_operation",
      resourceId: operation.id,
      metadata: {
        status: input.status,
        stage: operation.stage,
        error_code: input.errorCode ?? null,
      },
    });
  }
}

/** Signals that the operation already has a terminal safety checkpoint. */
export class MetaExecutionInterrupted extends Error {}
export interface MetaExecutionContext {
  operation: MetaOperation;
  resolved: ResolvedMetaAsset;
  graph: MetaGraphClient;
  db: Admin;
  beforeDispatch(): Promise<void>;
  dispatch<T>(
    stage: string,
    action: () => Promise<T>,
    externalIdsFromResult: (result: T) => Record<string, unknown>,
    extraGuard?: () => Promise<void>,
    finalReceiptFromResult?: (result: T) => Record<string, unknown>,
  ): Promise<T>;
  read<T>(action: () => Promise<T>): Promise<T>;
  checkpoint(input: MetaOperationCheckpoint): Promise<void>;
  /** Optional read after confirmed success; cannot downgrade or requeue the operation. */
  enrichReceipt(action: () => Promise<Record<string, unknown>>): Promise<void>;
}
async function refreshAuthorization(operation: MetaOperation, db: Admin): Promise<void> {
  const store = new MetaConnectionStore(db);
  const connection = await store.connection(operation.organization_id, operation.connection_id);
  const app = await getPlatformMetaAppNative();
  if (
    !app.nativeEnabled ||
    app.appId !== connection.app_id ||
    connection.version !== operation.authorization_version
  )
    throw unavailable();
  const graph = new MetaGraphClient(app);
  try {
    const inspected = await graph.inspectToken(
      await store.token(connection),
      connection.remote_actor_id,
    );
    inspected.assets = await graph.discoverAssets(inspected);
    await store.refreshInventory(connection, inspected);
  } catch (e) {
    if (
      e instanceof MetaIntegrationError &&
      ["meta_token_invalid", "meta_permission_missing"].includes(e.code)
    ) {
      await store.markInvalid(
        connection,
        e.code === "meta_permission_missing" ? "scope_missing" : "revoked",
      );
    }
    throw e;
  }
}
export function createMetaExecutionContext(
  operation: MetaOperation,
  resolved: ResolvedMetaAsset,
  store = new MetaOperationStore(),
  resolver = resolveSelectedMetaAsset,
  graph = new MetaGraphClient(resolved.app),
  refresh = refreshAuthorization,
): MetaExecutionContext {
  const beforeDispatch = async () => {
    await store.heartbeat(operation);
    await refresh(operation, store.db);
    await store.heartbeat(operation);
    const fresh = await resolver(
      operation.organization_id,
      operation.asset_id,
      operation.kind === "instagram_publish" ? "instagram_publish" : "ads_manage",
      operation.connection_id,
      store.db,
    );
    if (
      fresh.authorizationVersion !== operation.authorization_version ||
      fresh.grantId !== operation.grant_id ||
      !(await store.authorized(operation))
    )
      throw unavailable();
    if (
      fresh.app.appSecret !== resolved.app.appSecret ||
      fresh.app.apiVersion !== resolved.app.apiVersion
    )
      graph = new MetaGraphClient(fresh.app);
    // A live grant may refresh its Page token without changing its authorization version.
    Object.assign(resolved, fresh);
  };
  return {
    operation,
    resolved,
    get graph() {
      return graph;
    },
    db: store.db,
    beforeDispatch,
    checkpoint: (input) => store.checkpoint(operation, input),
    read: async (action) => {
      await beforeDispatch();
      return action();
    },
    enrichReceipt: async (action) => {
      if (operation.status !== "succeeded") return;
      try {
        if (!(await store.authorized(operation))) return;
        const receipt = { ...operation.receipt, ...(await action()) };
        const { error } = await store.db
          .from("meta_operations")
          .update({ receipt: receipt as never })
          .eq("organization_id", operation.organization_id)
          .eq("id", operation.id)
          .eq("status", "succeeded")
          .eq("fence", operation.fence);
        if (error) throw dbFailure();
        operation.receipt = receipt;
      } catch {
        // The write already has its durable receipt. Read/enrichment failure cannot undo it.
        void audit({
          action: "meta.operation_checkpointed",
          actorUserId: operation.actor_id,
          organizationId: operation.organization_id,
          resourceType: "meta_operation",
          resourceId: operation.id,
          metadata: { status: "succeeded", stage: "receipt_enrichment_unavailable" },
        });
      }
    },
    dispatch: async (stage, action, idsFromResult, extraGuard, finalReceiptFromResult) => {
      await beforeDispatch();
      if (extraGuard) await extraGuard();
      await store.beginDispatch(operation);
      try {
        const result = await action();
        const ids = idsFromResult(result);
        if (!Object.keys(ids).length) throw new Error("missing provider receipt");
        await store.checkpoint(operation, {
          status: finalReceiptFromResult ? "succeeded" : "executing",
          stage,
          externalIds: ids,
          ...(finalReceiptFromResult ? { receipt: finalReceiptFromResult(result) } : {}),
        });
        return result;
      } catch {
        // No automatic resend after an accepted response lost its local receipt, a timeout or a lost fence.
        try {
          await store.checkpoint(operation, {
            status: "uncertain",
            stage,
            errorCode: "meta_dispatch_uncertain",
            errorMessage: "O provedor ainda não confirmou este envio. Não repita a operação.",
          });
        } catch {
          // The durable dispatch marker remains set. Lease recovery quarantines it;
          // allowing a generic retry to clear it could resend a successful POST.
        }
        throw new MetaExecutionInterrupted("meta_dispatch_uncertain");
      }
    },
  };
}
