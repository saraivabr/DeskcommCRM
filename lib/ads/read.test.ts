import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  read: vi.fn(),
  status: vi.fn(),
  assets: vi.fn(),
}));
vi.mock("@/lib/channels/meta/social/operations", () => ({ resolveMetaAsset: mocks.resolve }));
vi.mock("@/lib/channels/meta/social/graph", () => ({ MetaGraphClient: class {} }));
vi.mock("@/lib/channels/meta/app", () => ({
  getPlatformMetaAppNative: async () => ({
    nativeEnabled: true,
    appId: "app",
    configId: "config",
    appSecret: "server-fixture",
  }),
}));
vi.mock("@/lib/channels/meta/social/store", () => ({
  MetaConnectionStore: class {
    status = mocks.status;
    assets = mocks.assets;
  },
}));
vi.mock("@/lib/plataformas-de-anuncio/meta/native-insights", () => ({
  readNativeCampaigns: mocks.read,
}));
import { nativeAdAccounts, nativeCampaigns } from "./read";
const input = {
  source: "native" as const,
  asset_id: "33333333-3333-4333-8333-333333333333",
  connection_id: "22222222-2222-4222-8222-222222222222",
  from: "2026-09-01",
  to: "2026-09-07",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    app: {},
    connectionId: input.connection_id,
    authorizationVersion: 3,
    asset: { external_id: "12", currency: "BRL", timezone: "America/Sao_Paulo" },
    token: "server-only-fixture",
  });
  mocks.read.mockResolvedValue({
    campaigns: [{ id: "101", name: "Sem veiculação", status: "PAUSED" }],
    insights: [],
  });
});
describe("autoridade da leitura Ads", () => {
  it("nega ativo não autorizado antes de consumir Graph", async () => {
    mocks.resolve.mockRejectedValue(new Error("not selected"));
    await expect(nativeCampaigns("trusted-org", input)).rejects.toThrow("not selected");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("não entrega dados se a conexão mudar durante a consulta", async () => {
    mocks.resolve
      .mockResolvedValueOnce({
        app: {},
        connectionId: input.connection_id,
        authorizationVersion: 3,
        asset: { external_id: "12" },
        token: "fixture",
      })
      .mockResolvedValueOnce({ authorizationVersion: 4 });
    await expect(nativeCampaigns("trusted-org", input)).rejects.toMatchObject({
      code: "meta_authorization_changed",
    });
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      1,
      "trusted-org",
      input.asset_id,
      "ads_read",
      input.connection_id,
    );
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      2,
      "trusted-org",
      input.asset_id,
      "ads_read",
      input.connection_id,
    );
  });
  it("retorna somente DTO seguro e ausência de métrica continua nula", async () => {
    const result = await nativeCampaigns("trusted-org", input);
    expect(result).toMatchObject({
      source: "native",
      asset_id: input.asset_id,
      connection_id: input.connection_id,
      currency: "BRL",
      campanhas: [{ campanhaId: "101", status: "PAUSED", gasto: null }],
    });
    expect(JSON.stringify(result)).not.toContain("server-only-fixture");
    expect(JSON.stringify(result)).not.toContain("appSecret");
  });
  it("lista apenas contas explicitamente selecionadas com capacidade efetiva de leitura", async () => {
    mocks.status.mockResolvedValue({
      connections: [
        { id: input.connection_id, status: "healthy" },
        { id: "revoked-connection", status: "revoked" },
      ],
    });
    mocks.assets.mockResolvedValue([
      {
        id: input.asset_id,
        kind: "ad_account",
        selected: true,
        capabilities: { ads_read: true, ads_manage: false, instagram_publish: false },
        name: "Conta",
        external_id: "12",
        currency: "BRL",
        timezone: null,
      },
      { id: "unselected", kind: "ad_account", selected: false, capabilities: { ads_read: true } },
      {
        id: "missing-scope",
        kind: "ad_account",
        selected: true,
        capabilities: { ads_read: false },
      },
    ]);
    const result = await nativeAdAccounts("trusted-org");
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.asset_id).toBe(input.asset_id);
    expect(mocks.assets).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
