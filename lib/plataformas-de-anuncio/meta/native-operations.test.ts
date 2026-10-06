import { beforeEach, describe, it, expect, vi } from "vitest";
import type { MetaExecutionContext } from "@/lib/channels/meta/social/operations";
import { draftReviewHash } from "@/lib/ads/review";
import { trafficTargeting } from "@/lib/ads/schema";
import type { StoredAdDraft } from "@/lib/ads/drafts";
const mocks = vi.hoisted(() => ({ load: vi.fn(), image: vi.fn(), page: vi.fn() }));
vi.mock("@/lib/ads/drafts", () => ({
  loadStoredDraft: mocks.load,
  loadDraftImage: mocks.image,
  requireAdPage: mocks.page,
  reviewHash: (draft: Record<string, unknown>) => {
    const {
      status: _status,
      approved_hash: _hash,
      approved_revision: _revision,
      ...content
    } = draft;
    return draftReviewHash(content);
  },
}));
import { executeNativeAdsOperation } from "./native-operations";
const org = "11111111-1111-4111-8111-111111111111",
  connection = "22222222-2222-4222-8222-222222222222",
  asset = "33333333-3333-4333-8333-333333333333",
  page = "44444444-4444-4444-8444-444444444444",
  draftId = "55555555-5555-4555-8555-555555555555",
  imageId = "66666666-6666-4666-8666-666666666666";
let draft: StoredAdDraft;
function hash(draft: StoredAdDraft) {
  const { status: _status, approved_hash: _hash, approved_revision: _revision, ...content } = draft;
  return draftReviewHash(content);
}
function context(options: { mismatch?: boolean; failAt?: string; existing?: boolean } = {}) {
  const operation = {
    id: "77777777-7777-4777-8777-777777777777",
    organization_id: org,
    connection_id: connection,
    asset_id: asset,
    authorization_version: 3,
    kind: "ads_create",
    request_payload: {
      campaign_draft_id: draft.id,
      draft_revision: draft.revision,
      approved_hash: draft.approved_hash,
    },
    external_ids: options.existing
      ? {
          image_hash: "a".repeat(32),
          campaign_id: "101",
          adset_id: "102",
          creative_id: "103",
          ad_id: "104",
        }
      : {},
  };
  const request = vi.fn(
    async (
      path: string,
      _token: string,
      parameters?: { method?: string; body?: Record<string, string> },
    ) => {
      if (options.failAt && path.endsWith(options.failAt) && parameters?.method === "POST")
        throw new Error("provider timeout after dispatch");
      if (parameters?.method === "POST")
        return path.endsWith("/adimages")
          ? { images: { image: { hash: "a".repeat(32) } } }
          : {
              id: path.endsWith("/campaigns")
                ? "101"
                : path.endsWith("/adsets")
                  ? "102"
                  : path.endsWith("/adcreatives")
                    ? "103"
                    : "104",
            };
      if (path === "act_12") return { currency: "BRL", account_status: 1 };
      if (path === "101")
        return { id: "101", status: "PAUSED", account_id: "12", objective: "OUTCOME_TRAFFIC" };
      if (path === "102")
        return {
          id: "102",
          status: "PAUSED",
          campaign_id: "101",
          daily_budget: options.mismatch ? "3501" : "3500",
          start_time: draft.starts_at,
          end_time: draft.ends_at,
        };
      return {
        id: "104",
        status: "PAUSED",
        account_id: "12",
        adset_id: "102",
        campaign_id: "101",
        creative: { id: "103" },
      };
    },
  );
  const beforeDispatch = vi.fn(async () => {}),
    checkpoint = vi.fn(async () => {});
  const dispatch = vi.fn(
    async (
      _stage: string,
      action: () => Promise<unknown>,
      ids: (value: unknown) => Record<string, unknown>,
      guard?: () => Promise<void>,
    ) => {
      await beforeDispatch();
      await guard?.();
      const result = await action();
      Object.assign(operation.external_ids, ids(result));
      return result;
    },
  );
  return {
    operation,
    resolved: {
      connectionId: connection,
      authorizationVersion: 3,
      asset: { external_id: "12", currency: "BRL" },
      app: { appId: "app-fixture" },
      token: "server-only-fixture",
    },
    graph: { request },
    beforeDispatch,
    dispatch,
    read: async (action: () => Promise<unknown>) => {
      await beforeDispatch();
      return action();
    },
    checkpoint,
  } as unknown as MetaExecutionContext;
}
beforeEach(() => {
  vi.clearAllMocks();
  draft = {
    id: draftId,
    revision: 2,
    status: "approved",
    ad_account_asset_id: asset,
    page_asset_id: page,
    name: "Agenda",
    objective: "OUTCOME_TRAFFIC",
    destination_url: "https://example.com/agenda",
    daily_budget_cents: 3500,
    currency: "BRL",
    starts_at: "2030-01-01T12:00:00Z",
    ends_at: "2030-01-08T12:00:00Z",
    targeting: trafficTargeting,
    creative: {
      studio_item_id: imageId,
      message: "Veja a agenda",
      title: "Agenda",
      connection_id: connection,
      authorization_version: 3,
      image_sha256: "b".repeat(64),
      asset_path: `${org}/instagram/image.jpg`,
    },
    approved_revision: 2,
    approved_hash: null,
  };
  draft.approved_hash = hash(draft);
  mocks.load.mockImplementation(async () => structuredClone(draft));
  mocks.image.mockResolvedValue({
    bytes: Buffer.from("owned-studio-image"),
    path: draft.creative.asset_path,
    hash: draft.creative.image_sha256,
  });
  mocks.page.mockResolvedValue("99");
});
describe("criação nativa de anúncios pausados", () => {
  it("desativa explicitamente o compartilhamento de orçamento no POST da campanha pausada", async () => {
    const ctx = context();
    await executeNativeAdsOperation(ctx);
    const campaigns = vi
      .mocked(ctx.graph.request)
      .mock.calls.filter((call) => call[0] === "act_12/campaigns" && call[2]?.method === "POST");
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]?.[2]?.body).toEqual({
      name: draft.name,
      objective: "OUTCOME_TRAFFIC",
      special_ad_categories: "[]",
      status: "PAUSED",
      is_adset_budget_sharing_enabled: "false",
    });
  });
  it("grava checkpoints de todos os objetos e confirma orçamento e PAUSED antes do sucesso", async () => {
    const ctx = context();
    await executeNativeAdsOperation(ctx);
    const calls = vi.mocked(ctx.graph.request).mock.calls;
    const posts = calls.filter((call) => call[2]?.method === "POST");
    expect(posts).toHaveLength(5);
    for (const suffix of ["/campaigns", "/adsets", "/ads"])
      expect(posts.find((call) => call[0].endsWith(suffix))?.[2]?.body?.status).toBe("PAUSED");
    expect(posts.find((call) => call[0].endsWith("/adsets"))?.[2]?.body?.daily_budget).toBe("3500");
    expect(
      posts.find((call) => call[0].endsWith("/adcreatives"))?.[2]?.body?.object_story_spec,
    ).toContain('"page_id":"99"');
    expect(ctx.dispatch).toHaveBeenCalledTimes(5);
    expect(mocks.page).toHaveBeenCalledWith(org, page, connection, 3, "app-fixture");
    expect(ctx.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        stage: "paused_verified",
        receipt: expect.objectContaining({
          status: "PAUSED",
          daily_budget_cents: 3500,
          currency: "BRL",
          campaign_id: "101",
          adset_id: "102",
          ad_id: "104",
        }),
      }),
    );
  });
  it("não cria objeto quando a Página perdeu o grant selecionado", async () => {
    mocks.page.mockRejectedValue(new Error("page revoked"));
    const ctx = context();
    await expect(executeNativeAdsOperation(ctx)).rejects.toThrow("page revoked");
    expect(ctx.graph.request).not.toHaveBeenCalled();
  });
  it("não cria objeto com imagem diferente da revisão aprovada", async () => {
    mocks.image.mockResolvedValue({ bytes: Buffer.from("changed"), hash: "c".repeat(64) });
    const ctx = context();
    await expect(executeNativeAdsOperation(ctx)).rejects.toMatchObject({
      code: "meta_draft_changed",
    });
    expect(ctx.graph.request).not.toHaveBeenCalled();
  });
  it("recusa orçamento alterado depois da aprovação antes de chamar Graph", async () => {
    const ctx = context();
    draft.daily_budget_cents = 4500;
    await expect(executeNativeAdsOperation(ctx)).rejects.toMatchObject({
      code: "meta_draft_changed",
    });
    expect(ctx.graph.request).not.toHaveBeenCalled();
  });
  it("preserva IDs conhecidos e não repete etapas quando o conjunto falha", async () => {
    const ctx = context({ failAt: "/adsets" });
    await expect(executeNativeAdsOperation(ctx)).rejects.toThrow("provider timeout");
    expect(ctx.operation.external_ids).toMatchObject({
      campaign_id: "101",
      image_hash: "a".repeat(32),
    });
    expect(vi.mocked(ctx.graph.request).mock.calls.some((call) => call[0].endsWith("/ads"))).toBe(
      false,
    );
    expect(ctx.checkpoint).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
  });
  it("marca divergência de orçamento lido como incerta, sem anunciar criação confirmada", async () => {
    const ctx = context({ mismatch: true });
    await executeNativeAdsOperation(ctx);
    expect(ctx.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ status: "uncertain", stage: "verification_required" }),
    );
    expect(ctx.checkpoint).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
  });
  it("confere os recibos existentes com leitura e não cria os mesmos objetos novamente", async () => {
    const ctx = context({ existing: true });
    await executeNativeAdsOperation(ctx);
    expect(vi.mocked(ctx.graph.request).mock.calls.some((call) => call[2]?.method === "POST")).toBe(
      false,
    );
    expect(ctx.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });
});
