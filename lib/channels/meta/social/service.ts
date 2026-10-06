import { z } from "zod";
import { audit } from "@/lib/audit";
import { getPlatformMetaAppNative } from "@/lib/channels/meta/app";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { MetaGraphClient } from "./graph";
import { tokenExpired } from "./capabilities";
import {
  META_CALLBACK_PATH,
  META_OAUTH_TTL_SECONDS,
  metaAppConfigured,
  montarMetaAuthorizationUrl,
  opaqueNonce,
  type MetaCallbackError,
} from "./oauth";
import { MetaConnectionStore, type MetaActorContext, type MetaClaimedAttempt } from "./store";
import { MetaIntegrationError, type MetaNativeApp, type MetaStatusDTO } from "./types";

export class MetaNativeService {
  constructor(
    private readonly store = new MetaConnectionStore(),
    private readonly loadApp: () => Promise<MetaNativeApp> = getPlatformMetaAppNative,
    private readonly graphFactory = (app: MetaNativeApp) => new MetaGraphClient(app),
  ) {}

  async start(actor: MetaActorContext, origin: string, requestId?: string) {
    const app = await this.loadApp();
    const state = opaqueNonce();
    const cookie = opaqueNonce();
    const url = montarMetaAuthorizationUrl(app, origin, state);
    await this.store.createAttempt(
      actor,
      app,
      state,
      cookie,
      new Date(Date.now() + META_OAUTH_TTL_SECONDS * 1000).toISOString(),
    );
    void audit({
      action: "meta.oauth_started",
      actorUserId: actor.actorId,
      organizationId: actor.organizationId,
      actorAuthSessionId: actor.sessionId,
      requestId,
      resourceType: "meta_connections",
      metadata: { app_id: app.appId },
    });
    return { authorization_url: url, cookie };
  }

  async callback(
    input: { state: string; code?: string; error?: string },
    cookie: string,
    origin: string,
    requestId?: string,
  ): Promise<{ ticket: string } | { error: MetaCallbackError }> {
    const attempt = await this.store.claim(input.state, cookie);
    if (!attempt) return { error: "invalid_state" };
    let reason: MetaCallbackError = "provider_error";
    try {
      if (input.error || !input.code) {
        reason = "cancelled";
        throw new MetaIntegrationError("meta_cancelled", "O login foi cancelado.", 409);
      }
      const app = await this.loadApp();
      if (
        !metaAppConfigured(app) ||
        app.appId !== attempt.app_id ||
        app.configId !== attempt.config_id ||
        app.revision !== attempt.config_revision
      ) {
        reason = "config_changed";
        throw new MetaIntegrationError(
          "meta_config_changed",
          "O app foi atualizado durante o login. Comece novamente.",
          409,
        );
      }
      if (
        !(await supportCallbackWriteAllowed(
          attempt.organization_id,
          attempt.actor_id,
          attempt.auth_session_id,
        ))
      ) {
        throw new MetaIntegrationError(
          "meta_support_expired",
          "O acompanhamento terminou. Comece novamente em uma sessão válida.",
          403,
        );
      }
      const result = await this.graphFactory(app).exchangeCode(
        input.code,
        new URL(META_CALLBACK_PATH, origin).toString(),
      );
      const ticket = opaqueNonce();
      await this.store.storeResult(attempt, ticket, result);
      return { ticket };
    } catch (error) {
      await this.failCallback(
        attempt,
        error instanceof MetaIntegrationError ? error.code : "meta_callback_failed",
        requestId,
      );
      return { error: reason };
    }
  }

  private async failCallback(attempt: MetaClaimedAttempt, reason: string, requestId?: string) {
    await this.store.failAttempt(attempt);
    void audit({
      action: "meta.oauth_failed",
      actorUserId: attempt.actor_id,
      organizationId: attempt.organization_id,
      actorAuthSessionId: attempt.auth_session_id,
      requestId,
      resourceType: "meta_connections",
      metadata: { reason },
    });
  }

  async finalize(actor: MetaActorContext, ticket: string, requestId?: string) {
    const result = await this.store.finalize(actor, ticket);
    void audit({
      action: "meta.connected",
      actorUserId: actor.actorId,
      organizationId: actor.organizationId,
      actorAuthSessionId: actor.sessionId,
      requestId,
      resourceType: "meta_connections",
      resourceId: result.connection_id,
      metadata: { version: result.version },
    });
    return result;
  }

  async status(organizationId: string): Promise<MetaStatusDTO> {
    const app = await this.loadApp();
    return this.store.status(organizationId, app, metaAppConfigured(app));
  }

  async assets(organizationId: string, connectionId: string) {
    return { assets: await this.store.assets(organizationId, connectionId, await this.loadApp()) };
  }

  private async validateInventory(
    actor: MetaActorContext,
    connectionId: string,
    requestId?: string,
  ) {
    const connection = await this.store.connection(actor.organizationId, connectionId);
    const app = await this.loadApp();
    if (!metaAppConfigured(app) || connection.app_id !== app.appId) {
      throw new MetaIntegrationError(
        "meta_config_changed",
        "A configuração Meta mudou. Reconecte usando o app atual.",
        409,
      );
    }
    try {
      const token = await this.store.token(connection);
      const graph = this.graphFactory(app);
      const validated = await graph.inspectToken(token, connection.remote_actor_id);
      validated.assets = await graph.discoverAssets(validated);
      await this.store.refreshInventory(connection, validated);
      void audit({
        action: "meta.connection_checked",
        actorUserId: actor.actorId,
        organizationId: actor.organizationId,
        actorAuthSessionId: actor.sessionId,
        requestId,
        resourceType: "meta_connections",
        resourceId: connectionId,
        metadata: { outcome: "validated", asset_count: validated.assets.length },
      });
    } catch (error) {
      if (
        error instanceof MetaIntegrationError &&
        ["meta_token_invalid", "meta_permission_missing"].includes(error.code)
      ) {
        await this.store.markInvalid(
          connection,
          error.code === "meta_token_invalid"
            ? tokenExpired(connection.token_expires_at, connection.data_access_expires_at)
              ? "token_expired"
              : "revoked"
            : "scope_missing",
        );
        void audit({
          action: "meta.connection_checked",
          actorUserId: actor.actorId,
          organizationId: actor.organizationId,
          actorAuthSessionId: actor.sessionId,
          requestId,
          resourceType: "meta_connections",
          resourceId: connectionId,
          metadata: { outcome: "invalid", reason: error.code },
        });
      }
      throw error;
    }
  }

  async checkConnection(actor: MetaActorContext, connectionId: string, requestId?: string) {
    try {
      await this.validateInventory(actor, connectionId, requestId);
    } catch (error) {
      // Verificar uma conexão revogada é um resultado conhecido, exibido já nesta resposta.
      // Falha de rede/persistência permanece erro e nunca finge verificação concluída.
      if (
        !(error instanceof MetaIntegrationError) ||
        !["meta_token_invalid", "meta_permission_missing"].includes(error.code)
      )
        throw error;
    }
    return this.status(actor.organizationId);
  }

  async selectAssets(
    actor: MetaActorContext,
    connectionId: string,
    assetIds: string[],
    requestId?: string,
  ) {
    await this.validateInventory(actor, connectionId, requestId);
    const safeAssets = await this.store.assets(
      actor.organizationId,
      connectionId,
      await this.loadApp(),
    );
    if (assetIds.some((id) => !safeAssets.some((asset) => asset.id === id))) {
      throw new MetaIntegrationError(
        "meta_asset_not_found",
        "Um dos ativos não pertence a esta conexão e organização.",
        404,
      );
    }
    const result = await this.store.selectAssets(actor, connectionId, [...new Set(assetIds)]);
    void audit({
      action: "meta.assets_selected",
      actorUserId: actor.actorId,
      organizationId: actor.organizationId,
      actorAuthSessionId: actor.sessionId,
      requestId,
      resourceType: "meta_connections",
      resourceId: connectionId,
      metadata: { selected_count: new Set(assetIds).size },
    });
    const safeResult = z
      .object({
        connection_id: z.string().uuid(),
        selected_count: z.number().int().nonnegative(),
        status: z.string(),
      })
      .safeParse(result);
    if (!safeResult.success)
      throw new MetaIntegrationError(
        "meta_store_unavailable",
        "A seleção não pôde ser confirmada.",
      );
    return { ...safeResult.data, ...(await this.assets(actor.organizationId, connectionId)) };
  }

  async disconnect(actor: MetaActorContext, connectionId: string, requestId?: string) {
    await this.store.connection(actor.organizationId, connectionId);
    const result = await this.store.disconnect(actor, connectionId);
    void audit({
      action: "meta.disconnected",
      actorUserId: actor.actorId,
      organizationId: actor.organizationId,
      actorAuthSessionId: actor.sessionId,
      requestId,
      resourceType: "meta_connections",
      resourceId: connectionId,
    });
    const safeResult = z
      .object({ disconnected_count: z.number().int().nonnegative() })
      .safeParse(result);
    if (!safeResult.success)
      throw new MetaIntegrationError(
        "meta_store_unavailable",
        "A desconexão não pôde ser confirmada.",
      );
    return safeResult.data;
  }
}
