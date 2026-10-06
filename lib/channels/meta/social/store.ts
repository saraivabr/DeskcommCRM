import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { assetCapabilities, capabilityFlags, tokenExpired } from "./capabilities";
import { hashOpaque } from "./oauth";
import {
  metaAssetKindSchema,
  metaConnectionStatusSchema,
  metaGranularScopeSchema,
  MetaIntegrationError,
  type MetaAssetDTO,
  type MetaNativeApp,
  type MetaPendingResult,
  type MetaStatusDTO,
} from "./types";

export interface MetaActorContext {
  organizationId: string;
  actorId: string;
  sessionId: string;
}
const attemptSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  actor_id: z.string().uuid(),
  auth_session_id: z.string(),
  app_id: z.string(),
  config_id: z.string(),
  config_revision: z.number(),
  callback_claim_id: z.string().uuid(),
});
export type MetaClaimedAttempt = z.infer<typeof attemptSchema>;
const connectionSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  app_id: z.string(),
  local_actor_id: z.string().uuid(),
  remote_actor_id: z.string(),
  actor_name: z.string().nullable(),
  status: metaConnectionStatusSchema,
  oauth_access_token_encrypted: z.string().nullable(),
  token_type: z.string(),
  token_expires_at: z.string().nullable(),
  data_access_expires_at: z.string().nullable(),
  scopes: z.array(z.string()),
  granular_scopes: z.array(metaGranularScopeSchema),
  version: z.number(),
  last_validated_at: z.string().nullable(),
});
export type MetaStoredConnection = z.infer<typeof connectionSchema>;
const assetSchema = z.object({
  id: z.string().uuid(),
  kind: metaAssetKindSchema,
  external_id: z.string(),
  name: z.string(),
  parent_page_id: z.string().uuid().nullable(),
  currency: z.string().nullable(),
  timezone: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
const grantSchema = z.object({
  asset_id: z.string().uuid(),
  tasks: z.array(z.string()),
  permissions: z.array(z.string()),
  status: z.string(),
  selected: z.boolean(),
});

function databaseFailure(): MetaIntegrationError {
  return new MetaIntegrationError(
    "meta_store_unavailable",
    "Não foi possível persistir ou consultar a conexão Meta. Tente novamente.",
  );
}

export class MetaConnectionStore {
  constructor(private readonly db = createAdminClient()) {}

  async createAttempt(
    actor: MetaActorContext,
    app: MetaNativeApp,
    state: string,
    cookie: string,
    expiresAt: string,
  ): Promise<void> {
    const { error } = await this.db.from("meta_oauth_attempts").insert({
      organization_id: actor.organizationId,
      actor_id: actor.actorId,
      auth_session_id: actor.sessionId,
      app_id: app.appId,
      config_id: app.configId,
      config_revision: app.revision,
      state_hash: hashOpaque(state),
      cookie_hash: hashOpaque(cookie),
      expires_at: expiresAt,
    });
    if (error) throw databaseFailure();
  }

  async claim(state: string, cookie: string): Promise<MetaClaimedAttempt | null> {
    // A organização vem da prova opaca consumida atomicamente, nunca de query/body.
    const { data, error } = await this.db.rpc("fn_meta_oauth_claim", {
      p_state_hash: hashOpaque(state),
      p_cookie_hash: hashOpaque(cookie),
    });
    if (error) throw databaseFailure();
    if (!data) return null;
    const parsed = attemptSchema.safeParse(data);
    if (!parsed.success) throw databaseFailure();
    return parsed.data;
  }

  async failAttempt(attempt: MetaClaimedAttempt): Promise<void> {
    const { error } = await this.db
      .from("meta_oauth_attempts")
      .update({ status: "failed", pending_result_encrypted: null, ticket_hash: null })
      .eq("organization_id", attempt.organization_id)
      .eq("id", attempt.id)
      .eq("callback_claim_id", attempt.callback_claim_id)
      .eq("status", "exchanging");
    if (error) throw databaseFailure();
  }

  async storeResult(
    attempt: MetaClaimedAttempt,
    ticket: string,
    result: MetaPendingResult,
  ): Promise<void> {
    const cipher = await encryptWebhookSecret(this.db, JSON.stringify(result));
    if (!cipher)
      throw new MetaIntegrationError(
        "meta_encryption_unavailable",
        "A instalação precisa configurar a cifra das credenciais antes de conectar.",
        503,
      );
    const { data, error } = await this.db.rpc("fn_meta_oauth_store_result", {
      p_attempt_id: attempt.id,
      p_callback_claim_id: attempt.callback_claim_id,
      p_ticket_hash: hashOpaque(ticket),
      p_result_encrypted: cipher,
    });
    if (error || data !== true) throw databaseFailure();
  }

  async finalize(
    actor: MetaActorContext,
    ticket: string,
  ): Promise<{ connection_id: string; version: number; status: string }> {
    const { data, error } = await this.db.rpc("fn_meta_oauth_finalize", {
      p_organization_id: actor.organizationId,
      p_actor_id: actor.actorId,
      p_auth_session_id: actor.sessionId,
      p_ticket_hash: hashOpaque(ticket),
    });
    if (error) {
      if (["PT403", "42501"].includes(error.code ?? ""))
        throw new MetaIntegrationError(
          "meta_finalize_denied",
          "Sua permissão nesta organização mudou. Peça a um administrador para reconectar.",
          403,
        );
      if (["PT400", "PT409", "P0001"].includes(error.code ?? ""))
        throw new MetaIntegrationError(
          "meta_finalize_denied",
          "Este retorno venceu, já foi usado ou pertence a outra sessão. Inicie novamente o login.",
          409,
        );
      throw databaseFailure();
    }
    const result = z
      .object({
        connection_id: z.string().uuid(),
        version: z.number(),
        status: metaConnectionStatusSchema,
      })
      .safeParse(data);
    if (!result.success) throw databaseFailure();
    return result.data;
  }

  async connection(organizationId: string, connectionId: string): Promise<MetaStoredConnection> {
    const { data, error } = await this.db
      .from("meta_connections")
      .select(
        "id,organization_id,app_id,local_actor_id,remote_actor_id,actor_name,status,oauth_access_token_encrypted,token_type,token_expires_at,data_access_expires_at,scopes,granular_scopes,version,last_validated_at",
      )
      .eq("organization_id", organizationId)
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw databaseFailure();
    if (!data)
      throw new MetaIntegrationError(
        "meta_connection_not_found",
        "Esta conexão não pertence à organização ativa.",
        404,
      );
    const parsed = connectionSchema.safeParse(data);
    if (!parsed.success) throw databaseFailure();
    return parsed.data;
  }

  async token(connection: MetaStoredConnection): Promise<string> {
    if (connection.status === "scope_missing")
      throw new MetaIntegrationError(
        "meta_permission_missing",
        "A conexão precisa de novas permissões. Reautorize o acesso.",
        409,
      );
    if (
      !connection.oauth_access_token_encrypted ||
      ["disconnected", "revoked", "token_expired"].includes(connection.status) ||
      tokenExpired(connection.token_expires_at, connection.data_access_expires_at)
    ) {
      throw new MetaIntegrationError(
        "meta_token_invalid",
        "A conexão precisa ser reautorizada antes de continuar.",
        409,
      );
    }
    const token = await decryptWebhookSecret(this.db, connection.oauth_access_token_encrypted);
    if (!token)
      throw new MetaIntegrationError(
        "meta_encryption_unavailable",
        "Não foi possível abrir a credencial. Verifique a configuração da instalação.",
        503,
      );
    return token;
  }

  async status(
    organizationId: string,
    app: MetaNativeApp,
    configured: boolean,
  ): Promise<MetaStatusDTO> {
    const { data, error } = await this.db
      .from("meta_connections")
      .select(
        "id,actor_name,status,token_expires_at,data_access_expires_at,scopes,last_validated_at,app_id",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw databaseFailure();
    const { data: grants, error: grantsError } = await this.db
      .from("meta_asset_grants")
      .select("connection_id,selected,status")
      .eq("organization_id", organizationId)
      .eq("selected", true)
      .eq("status", "healthy");
    if (grantsError) throw databaseFailure();
    const rows = z
      .array(
        z.object({
          id: z.string().uuid(),
          actor_name: z.string().nullable(),
          status: metaConnectionStatusSchema,
          token_expires_at: z.string().nullable(),
          data_access_expires_at: z.string().nullable(),
          scopes: z.array(z.string()),
          last_validated_at: z.string().nullable(),
          app_id: z.string(),
        }),
      )
      .safeParse(data ?? []);
    const safeGrants = z
      .array(
        z.object({ connection_id: z.string().uuid(), selected: z.boolean(), status: z.string() }),
      )
      .safeParse(grants ?? []);
    if (!rows.success || !safeGrants.success) throw databaseFailure();
    return {
      configured,
      capabilities: capabilityFlags(app),
      connections: rows.data.map((row) => {
        const expired = tokenExpired(row.token_expires_at, row.data_access_expires_at);
        const status =
          ["healthy", "selection_pending", "scope_missing"].includes(row.status) && expired
            ? ("token_expired" as const)
            : row.status;
        return {
          id: row.id,
          actor_name: row.actor_name ?? "Conta Meta",
          status,
          expires_at: row.token_expires_at,
          scopes: row.scopes,
          checked_at: row.last_validated_at,
          selected_asset_count: safeGrants.data.filter((g) => g.connection_id === row.id).length,
          reconnect_required:
            ["token_expired", "revoked", "disconnected", "scope_missing", "error"].includes(
              status,
            ) || row.app_id !== app.appId,
        };
      }),
    };
  }

  async assets(
    organizationId: string,
    connectionId: string,
    app: MetaNativeApp,
  ): Promise<MetaAssetDTO[]> {
    const connection = await this.connection(organizationId, connectionId);
    const { data: grants, error } = await this.db
      .from("meta_asset_grants")
      .select("asset_id,tasks,permissions,status,selected")
      .eq("organization_id", organizationId)
      .eq("connection_id", connectionId);
    if (error) throw databaseFailure();
    const parsedGrants = z.array(grantSchema).safeParse(grants ?? []);
    if (!parsedGrants.success) throw databaseFailure();
    if (!parsedGrants.data.length) return [];
    const { data: assets, error: assetError } = await this.db
      .from("meta_assets")
      .select("id,kind,external_id,name,parent_page_id,currency,timezone,metadata")
      .eq("organization_id", organizationId)
      .in(
        "id",
        parsedGrants.data.map((g) => g.asset_id),
      );
    if (assetError) throw databaseFailure();
    const parsedAssets = z.array(assetSchema).safeParse(assets ?? []);
    if (!parsedAssets.success) throw databaseFailure();
    return parsedAssets.data.map((asset) => {
      const grant = parsedGrants.data.find((g) => g.asset_id === asset.id)!;
      const active =
        connection.app_id === app.appId &&
        ["healthy", "selection_pending"].includes(connection.status) &&
        grant.status === "healthy" &&
        !tokenExpired(connection.token_expires_at, connection.data_access_expires_at);
      const result = assetCapabilities({
        app,
        kind: asset.kind,
        externalId: asset.external_id,
        parentPageExternalId: parsedAssets.data.find((a) => a.id === asset.parent_page_id)
          ?.external_id,
        scopes: connection.scopes,
        permissions: grant.permissions,
        granularScopes: connection.granular_scopes,
        tasks: grant.tasks,
        active,
        accountStatus:
          typeof asset.metadata.account_status === "number"
            ? asset.metadata.account_status
            : undefined,
      });
      return {
        id: asset.id,
        kind: asset.kind,
        external_id: asset.external_id,
        name: asset.name,
        username: typeof asset.metadata.username === "string" ? asset.metadata.username : null,
        currency: asset.currency,
        timezone: asset.timezone,
        selected: grant.selected,
        ...result,
      };
    });
  }

  async selectAssets(
    actor: MetaActorContext,
    connectionId: string,
    assetIds: string[],
  ): Promise<unknown> {
    const { data, error } = await this.db.rpc("fn_meta_select_assets", {
      p_organization_id: actor.organizationId,
      p_actor_id: actor.actorId,
      p_connection_id: connectionId,
      p_asset_ids: assetIds,
    });
    if (error)
      throw new MetaIntegrationError(
        "meta_asset_selection_denied",
        "Não foi possível selecionar estes ativos. Verifique a conexão e as permissões.",
        ["PT403", "42501"].includes(error.code ?? "") ? 403 : 409,
      );
    return data;
  }

  async refreshInventory(
    connection: MetaStoredConnection,
    result: MetaPendingResult,
  ): Promise<void> {
    const { data, error } = await this.db.rpc("fn_meta_refresh_inventory", {
      p_organization_id: connection.organization_id,
      p_connection_id: connection.id,
      p_expected_version: connection.version,
      p_assets: result.assets,
      p_scopes: result.scopes,
      p_granular_scopes: result.granular_scopes,
      p_token_expires_at: result.token_expires_at,
      p_data_access_expires_at: result.data_access_expires_at,
    });
    if (error || data !== true)
      throw new MetaIntegrationError(
        "meta_connection_changed",
        "A conexão mudou durante a verificação. Atualize a tela e tente novamente.",
        409,
      );
  }

  async markInvalid(
    connection: MetaStoredConnection,
    status: "revoked" | "scope_missing" | "token_expired",
  ): Promise<void> {
    const { error } = await this.db
      .from("meta_connections")
      .update({ status, last_validated_at: new Date().toISOString() })
      .eq("organization_id", connection.organization_id)
      .eq("id", connection.id)
      .eq("version", connection.version)
      .not("status", "in", "(disconnected,revoked)");
    if (error) throw databaseFailure();
  }

  async disconnect(actor: MetaActorContext, connectionId: string): Promise<unknown> {
    const { data, error } = await this.db.rpc("fn_meta_disconnect", {
      p_organization_id: actor.organizationId,
      p_actor_id: actor.actorId,
      p_connection_id: connectionId,
    });
    if (error) throw databaseFailure();
    return data;
  }
}
