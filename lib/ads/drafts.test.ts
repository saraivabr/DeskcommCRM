import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  resolve: vi.fn(),
  download: vi.fn(),
  reserve: vi.fn(),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ download: mocks.download, createSignedUrl: vi.fn() }) },
  }),
}));
vi.mock("@/lib/channels/meta/social/operations", () => ({
  resolveMetaAsset: mocks.resolve,
  MetaOperationStore: class {
    reserve = mocks.reserve;
  },
}));
import {
  approveDraft,
  createPausedDraft,
  loadDraftImage,
  requireAdPage,
  reviewHash,
  saveDraft,
  type StoredAdDraft,
} from "./drafts";
import { trafficTargeting, type AdDraftInput } from "./schema";
import { imageReviewHash } from "./review";
const org = "11111111-1111-4111-8111-111111111111",
  connection = "22222222-2222-4222-8222-222222222222",
  asset = "33333333-3333-4333-8333-333333333333",
  page = "44444444-4444-4444-8444-444444444444",
  draftId = "55555555-5555-4555-8555-555555555555",
  imageId = "66666666-6666-4666-8666-666666666666";
let draft: StoredAdDraft;
let edited = false;
let imageChanged = false;
let cas = true;
beforeEach(() => {
  vi.clearAllMocks();
  edited = false;
  imageChanged = false;
  cas = true;
  draft = {
    id: draftId,
    revision: 2,
    status: "draft",
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
      image_sha256: imageReviewHash(Buffer.from("owned-image")),
      asset_path: `${org}/instagram/image.jpg`,
    },
    approved_revision: null,
    approved_hash: null,
  };
  mocks.resolve.mockResolvedValue({
    connectionId: connection,
    authorizationVersion: 3,
    grantId: "77777777-7777-4777-8777-777777777777",
    app: { appId: "app" },
    asset: { currency: "BRL", timezone: "America/Sao_Paulo" },
  });
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.startsWith("select id,revision")) return { rows: [structuredClone(draft)] };
    if (sql.startsWith("select a.external_id"))
      return {
        rows: [
          {
            external_id: "99",
            tasks: ["ADVERTISE"],
            permissions: ["pages_show_list", "pages_read_engagement"],
            scopes: ["pages_show_list", "pages_read_engagement"],
            granular_scopes: [],
          },
        ],
      };
    if (sql.startsWith("select asset_path,input"))
      return { rows: [{ asset_path: draft.creative.asset_path, input: { format: "square" } }] };
    if (sql.startsWith("select id,status,stage")) return { rows: [] };
    if (sql.startsWith("update meta_campaign_drafts set status='approved'")) {
      edited = true;
      if (cas) {
        draft.status = "approved";
        draft.approved_revision = draft.revision;
        draft.approved_hash = String(params[3]);
      }
      return { rows: [], rowCount: cas ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  mocks.download.mockImplementation(async () => ({
    data: {
      size: 11,
      arrayBuffer: async () => Buffer.from(imageChanged ? "changed-image" : "owned-image"),
    },
    error: null,
  }));
  mocks.reserve.mockResolvedValue({ operation: { id: "operation-fixture" }, replay: false });
});
describe("aprovação e reserva da campanha", () => {
  it("exige o mesmo orçamento, moeda, revisão e hash vistos pela pessoa", async () => {
    for (const changed of [
      { daily_budget_cents: 3501 },
      { currency: "USD" },
      { revision: 1 },
      { review_hash: "0".repeat(64) },
    ])
      await expect(
        approveDraft(org, draftId, {
          revision: 2,
          review_hash: reviewHash(draft),
          daily_budget_cents: 3500,
          currency: "BRL",
          ...changed,
        }),
      ).rejects.toMatchObject({ code: "meta_draft_changed" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(edited).toBe(false);
  });
  it("não aprova uma imagem que mudou no storage depois de salvar", async () => {
    imageChanged = true;
    await expect(
      approveDraft(org, draftId, {
        revision: 2,
        review_hash: reviewHash(draft),
        daily_budget_cents: 3500,
        currency: "BRL",
      }),
    ).rejects.toMatchObject({ code: "meta_draft_changed" });
    expect(edited).toBe(false);
  });
  it("recusa aprovação perdida para uma edição concorrente", async () => {
    cas = false;
    await expect(
      approveDraft(org, draftId, {
        revision: 2,
        review_hash: reviewHash(draft),
        daily_budget_cents: 3500,
        currency: "BRL",
      }),
    ).rejects.toMatchObject({ code: "meta_draft_changed" });
    const call = mocks.query.mock.calls.find(([sql]) =>
      String(sql).startsWith("update meta_campaign_drafts set status='approved'"),
    );
    expect(call?.[0]).toContain("organization_id=$1");
    expect(call?.[0]).toContain("revision=$3");
    expect(call?.[1]).toEqual([org, draftId, 2, reviewHash(draft)]);
  });
  it("não reserva criação sem aprovação exata", async () => {
    await expect(
      createPausedDraft(org, "actor", draftId, { revision: 2, approved_hash: reviewHash(draft) }),
    ).rejects.toMatchObject({ code: "meta_draft_not_approved" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("reserva a revisão aprovada com chave estável e UUIDs internos da autorização", async () => {
    draft.status = "approved";
    draft.approved_revision = 2;
    draft.approved_hash = reviewHash(draft);
    await createPausedDraft(org, "actor", draftId, {
      revision: 2,
      approved_hash: draft.approved_hash,
    });
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: org,
        actorId: "actor",
        connectionId: connection,
        assetId: asset,
        authorizationVersion: 3,
        kind: "ads_create",
        operationKey: `ads-create:${draftId}:2`,
        payload: {
          campaign_draft_id: draftId,
          draft_revision: 2,
          approved_hash: draft.approved_hash,
        },
      }),
    );
  });
  it("recusa moeda diferente da conta antes de preparar mídia ou gravar", async () => {
    mocks.resolve.mockResolvedValue({ asset: { currency: "USD" } });
    const input = {
      id: draftId,
      connection_id: connection,
      ad_account_asset_id: asset,
      page_asset_id: page,
      name: draft.name,
      destination_url: draft.destination_url,
      daily_budget_cents: 3500,
      currency: "BRL",
      starts_at: draft.starts_at,
      ends_at: draft.ends_at,
      creative: { studio_item_id: imageId, message: "Texto", title: "Título" },
    } satisfies AdDraftInput;
    await expect(saveDraft(org, "actor", input)).rejects.toMatchObject({
      code: "meta_currency_mismatch",
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("limita Página a org/conexão/versão e recusa allowlist granular vazia", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          external_id: "99",
          tasks: ["MANAGE"],
          permissions: ["pages_show_list", "pages_read_engagement"],
          scopes: ["pages_show_list", "pages_read_engagement"],
          granular_scopes: [{ scope: "pages_show_list", target_ids: [] }],
        },
      ],
    });
    await expect(requireAdPage(org, page, connection, 3, "app")).rejects.toMatchObject({
      code: "meta_page_not_authorized",
    });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([org, page, connection, 3, "app"]);
  });
  it("não baixa uma imagem com path fora da organização", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ asset_path: "outra-org/instagram/image.jpg", input: { format: "square" } }],
    });
    await expect(loadDraftImage(org, imageId)).rejects.toMatchObject({
      code: "meta_draft_invalid",
    });
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
