import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaNativeService } from "./service";
import type { MetaConnectionStore } from "./store";
import type { MetaGraphClient } from "./graph";
import { MetaIntegrationError, type MetaNativeApp, type MetaPendingResult } from "./types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/meta/app", () => ({ getPlatformMetaAppNative: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(),
  decryptWebhookSecret: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({
  supportCallbackWriteAllowed: vi.fn(async () => true),
}));

const app: MetaNativeApp = {
  appId: "123",
  configId: "321",
  revision: 4,
  appSecret: "secret",
  apiVersion: "v22.0",
  nativeEnabled: true,
  instagramEnabled: true,
  adsEnabled: true,
};
const actor = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  sessionId: "10000000-0000-4000-8000-000000000003",
};
const attempt = {
  id: "10000000-0000-4000-8000-000000000004",
  organization_id: actor.organizationId,
  actor_id: actor.actorId,
  auth_session_id: actor.sessionId,
  app_id: "123",
  config_id: "321",
  config_revision: 4,
  callback_claim_id: "10000000-0000-4000-8000-000000000005",
};
const pending: MetaPendingResult = {
  remote_actor_id: "456",
  remote_actor_name: "Tester",
  access_token: "token-secret",
  token_type: "USER",
  token_expires_at: null,
  data_access_expires_at: null,
  scopes: [],
  granular_scopes: [],
  assets: [],
};
const store = {
  createAttempt: vi.fn(),
  claim: vi.fn(),
  storeResult: vi.fn(),
  failAttempt: vi.fn(),
  finalize: vi.fn(),
  connection: vi.fn(),
  token: vi.fn(),
  refreshInventory: vi.fn(),
  markInvalid: vi.fn(),
  selectAssets: vi.fn(),
  assets: vi.fn(),
  status: vi.fn(),
  disconnect: vi.fn(),
};
const graph = { exchangeCode: vi.fn(), inspectToken: vi.fn(), discoverAssets: vi.fn() };
const service = (config: MetaNativeApp = app) =>
  new MetaNativeService(
    store as unknown as MetaConnectionStore,
    async () => config,
    () => graph as unknown as MetaGraphClient,
  );

describe("duas fases do OAuth e concessões atuais", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.claim.mockResolvedValue(attempt);
    store.storeResult.mockResolvedValue(undefined);
    store.failAttempt.mockResolvedValue(undefined);
    graph.exchangeCode.mockResolvedValue(pending);
  });
  it("callback guarda resultado temporário sem ativar conexão", async () => {
    const result = await service().callback(
      { state: "s".repeat(43), code: "private-code" },
      "c".repeat(43),
      "https://produto.example",
    );
    expect(store.claim).toHaveBeenCalledWith("s".repeat(43), "c".repeat(43));
    expect(store.storeResult).toHaveBeenCalledWith(
      attempt,
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      pending,
    );
    expect(store.finalize).not.toHaveBeenCalled();
    expect(result).toEqual({ ticket: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("token-secret");
  });
  it("state/cookie não encontrados ou já consumidos não trocam código", async () => {
    store.claim.mockResolvedValue(null);
    expect(
      await service().callback(
        { state: "s".repeat(43), code: "private-code" },
        "bad",
        "https://produto.example",
      ),
    ).toEqual({ error: "invalid_state" });
    expect(graph.exchangeCode).not.toHaveBeenCalled();
    expect(store.storeResult).not.toHaveBeenCalled();
  });
  it("revisão do app mudou: apaga tentativa e pede novo login", async () => {
    expect(
      await service({ ...app, revision: 5 }).callback(
        { state: "s".repeat(43), code: "private-code" },
        "c".repeat(43),
        "https://produto.example",
      ),
    ).toEqual({ error: "config_changed" });
    expect(store.failAttempt).toHaveBeenCalledWith(attempt);
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });
  it("cancelamento é confirmado por vínculo antes de consumir a tentativa", async () => {
    expect(
      await service().callback(
        { state: "s".repeat(43), error: "access_denied" },
        "c".repeat(43),
        "https://produto.example",
      ),
    ).toEqual({ error: "cancelled" });
    expect(store.failAttempt).toHaveBeenCalledWith(attempt);
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });
  it("finalize usa uma única RPC local com ator/org/sessão atual", async () => {
    store.finalize.mockResolvedValue({
      connection_id: attempt.id,
      version: 2,
      status: "selection_pending",
    });
    expect(await service().finalize(actor, "t".repeat(43))).toEqual({
      connection_id: attempt.id,
      version: 2,
      status: "selection_pending",
    });
    expect(store.finalize).toHaveBeenCalledExactlyOnceWith(actor, "t".repeat(43));
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });
  it("seleção descobre de novo e rejeita ativo de outro tenant/conexão", async () => {
    store.connection.mockResolvedValue({
      id: attempt.id,
      organization_id: actor.organizationId,
      app_id: app.appId,
      remote_actor_id: "456",
      version: 2,
    });
    store.token.mockResolvedValue("token-secret");
    graph.inspectToken.mockResolvedValue({ ...pending });
    graph.discoverAssets.mockResolvedValue([]);
    store.refreshInventory.mockResolvedValue(undefined);
    store.assets.mockResolvedValue([]);
    await expect(
      service().selectAssets(actor, attempt.id, ["10000000-0000-4000-8000-000000000099"]),
    ).rejects.toMatchObject({ code: "meta_asset_not_found" });
    expect(graph.inspectToken).toHaveBeenCalledWith("token-secret", "456");
    expect(store.refreshInventory).toHaveBeenCalled();
    expect(store.selectAssets).not.toHaveBeenCalled();
  });
  it("health devolve o estado revogado persistido, sem manter snapshot healthy na resposta", async () => {
    store.connection.mockResolvedValue({
      id: attempt.id,
      organization_id: actor.organizationId,
      app_id: app.appId,
      remote_actor_id: "456",
      version: 2,
      token_expires_at: null,
      data_access_expires_at: null,
    });
    store.token.mockResolvedValue("token-secret");
    graph.inspectToken.mockRejectedValue(
      new MetaIntegrationError("meta_token_invalid", "Reconecte.", 409),
    );
    store.markInvalid.mockResolvedValue(undefined);
    store.status.mockResolvedValue({
      configured: true,
      capabilities: { ads_read: true, ads_manage: true, instagram_publish: true },
      connections: [{ id: attempt.id, status: "revoked", reconnect_required: true }],
    });
    const result = await service().checkConnection(actor, attempt.id);
    expect(store.markInvalid).toHaveBeenCalledWith(
      expect.objectContaining({ id: attempt.id, version: 2 }),
      "revoked",
    );
    expect(result.connections[0]).toMatchObject({ status: "revoked", reconnect_required: true });
  });
});
