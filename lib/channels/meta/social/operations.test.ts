import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalMetaJSON,
  createMetaExecutionContext,
  MetaExecutionInterrupted,
  MetaOperationStore,
  metaOperationDTO,
  resolveSelectedMetaAsset,
  type MetaOperation,
  type ResolvedMetaAsset,
} from "./operations";
import type { MetaGraphClient } from "./graph";
const mocks = vi.hoisted(() => ({
  app: vi.fn(),
  connection: vi.fn(),
  token: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/meta/app", () => ({ getPlatformMetaAppNative: mocks.app }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: mocks.decrypt }));
vi.mock("./store", () => ({
  MetaConnectionStore: class {
    connection = mocks.connection;
    token = mocks.token;
  },
}));
const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "10000000-0000-4000-8000-000000000002";
const GRANT = "10000000-0000-4000-8000-000000000003";
const PARENT = "10000000-0000-4000-8000-000000000004";
const app = {
  appId: "123",
  configId: "321",
  revision: 1,
  appSecret: "app-secret",
  apiVersion: "v22.0",
  nativeEnabled: true,
  adsEnabled: true,
  instagramEnabled: true,
};
const operation = (): MetaOperation => ({
  id: ID,
  organization_id: ORG,
  actor_id: ID,
  connection_id: ID,
  asset_id: ID,
  grant_id: GRANT,
  authorization_version: 1,
  kind: "ads_create",
  operation_key: "draft",
  request_hash: "a".repeat(64),
  request_payload: {},
  status: "executing",
  stage: "reserved",
  external_ids: {},
  receipt: null,
  error_code: null,
  error_message: null,
  lease_owner: "worker",
  lease_until: "2099-01-01",
  fence: 1,
  external_dispatch_started_at: null,
  retry_at: "2026-01-01",
  created_at: "2026-01-01",
  completed_at: null,
});
const resolved = (): ResolvedMetaAsset => ({
  app,
  connectionId: ID,
  grantId: GRANT,
  authorizationVersion: 1,
  token: "private-token",
  asset: {
    id: ID,
    kind: "ad_account",
    external_id: "act_12",
    name: "Account",
    parent_page_id: null,
    parent_page_external_id: null,
    currency: "BRL",
    timezone: null,
    metadata: {},
  },
});
function fakeDb(assets: unknown[], grants: unknown[]) {
  const eqs: [string, unknown][] = [];
  const from = vi.fn((table: string) => {
    const parent =
      grants.length &&
      typeof grants.at(-1) === "object" &&
      grants.at(-1) !== null &&
      !("id" in (grants.at(-1) as object)) &&
      "page_access_token_encrypted" in (grants.at(-1) as object);
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(),
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: parent ? grants.slice(0, -1) : grants, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockImplementation((key, value) => {
      eqs.push([key, value]);
      return query;
    });
    query.maybeSingle.mockImplementation(async () => ({
      data: table === "meta_assets" ? assets.shift() : grants.at(-1),
      error: null,
    }));
    return query;
  });
  return { db: { from } as unknown as SupabaseClient, eqs };
}
describe("selected Meta asset boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.app.mockResolvedValue(app);
    mocks.token.mockResolvedValue("user-token");
    mocks.decrypt.mockResolvedValue("page-token");
    mocks.connection.mockResolvedValue({
      id: ID,
      status: "healthy",
      app_id: "123",
      version: 1,
      token_expires_at: null,
      data_access_expires_at: null,
      scopes: [
        "ads_management",
        "instagram_basic",
        "instagram_content_publish",
        "pages_read_engagement",
      ],
      granular_scopes: [],
    });
  });
  it("rejects ambiguous connection choice before opening any token", async () => {
    const { db } = fakeDb([resolved().asset], [{}, {}]);
    await expect(
      resolveSelectedMetaAsset(ORG, ID, "ads_read", undefined, db),
    ).rejects.toMatchObject({ code: "meta_connection_ambiguous" });
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("Instagram publishes with the same connection's parent Page token, not its user token", async () => {
    const asset = {
      ...resolved().asset,
      kind: "instagram",
      external_id: "178",
      parent_page_id: PARENT,
    };
    const permissions = ["instagram_basic", "instagram_content_publish", "pages_read_engagement"];
    const grants = [
      {
        id: GRANT,
        connection_id: ID,
        asset_id: ID,
        selected: true,
        status: "healthy",
        tasks: ["CREATE_CONTENT"],
        permissions,
        page_access_token_encrypted: null,
      },
      { status: "healthy", page_access_token_encrypted: "\\xpage" },
    ];
    const { db, eqs } = fakeDb([asset, { external_id: "999" }], grants);
    const result = await resolveSelectedMetaAsset(ORG, ID, "instagram_publish", ID, db);
    expect(result.token).toBe("page-token");
    expect(mocks.token).not.toHaveBeenCalled();
    expect(eqs).toContainEqual(["asset_id", PARENT]);
    expect(eqs.filter(([key]) => key === "organization_id")).toHaveLength(4);
  });
  it("rejects revoked connection without decrypting Page tokens", async () => {
    mocks.connection.mockResolvedValue({ status: "scope_missing", app_id: "123" });
    const { db } = fakeDb(
      [resolved().asset],
      [
        {
          id: GRANT,
          connection_id: ID,
          asset_id: ID,
          selected: true,
          status: "healthy",
          tasks: ["MANAGE"],
          permissions: ["ads_management"],
          page_access_token_encrypted: null,
        },
      ],
    );
    await expect(resolveSelectedMetaAsset(ORG, ID, "ads_manage", ID, db)).rejects.toMatchObject({
      code: "meta_operation_not_authorized",
    });
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
});
describe("durable execution dispatch", () => {
  function context() {
    const op = operation();
    const target = resolved();
    const store = {
      db: {},
      heartbeat: vi.fn().mockResolvedValue(undefined),
      authorized: vi.fn().mockResolvedValue(true),
      beginDispatch: vi.fn().mockResolvedValue(undefined),
      checkpoint: vi.fn().mockResolvedValue(undefined),
    };
    const resolver = vi.fn().mockResolvedValue(target);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const ctx = createMetaExecutionContext(
      op,
      target,
      store as unknown as MetaOperationStore,
      resolver,
      {} as MetaGraphClient,
      refresh,
    );
    return { ctx, store, resolver, refresh, op };
  }
  it("reserves identical nested payloads with stable request hashes", async () => {
    expect(canonicalMetaJSON({ z: 1, a: { y: 2, x: 3 } })).toBe(
      canonicalMetaJSON({ a: { x: 3, y: 2 }, z: 1 }),
    );
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { operation: operation(), replay: true }, error: null });
    const store = new MetaOperationStore({ rpc } as unknown as SupabaseClient);
    const result = await store.reserve({
      organizationId: ORG,
      actorId: ID,
      connectionId: ID,
      assetId: ID,
      grantId: GRANT,
      authorizationVersion: 1,
      kind: "ads_create",
      operationKey: ID,
      payload: { draft: ID },
    });
    expect(result.replay).toBe(true);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_organization_id: ORG,
      p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it("refreshes Graph authorization and fences each dispatch before saving known external IDs", async () => {
    const { ctx, store, refresh } = context();
    const write = vi.fn().mockResolvedValue({ id: "123" });
    await ctx.dispatch<{ id: string }>("campaign_created", write, (r) => ({ campaign_id: r.id }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.beginDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      write.mock.invocationCallOrder[0]!,
    );
    expect(store.checkpoint).toHaveBeenCalledWith(ctx.operation, {
      status: "executing",
      stage: "campaign_created",
      externalIds: { campaign_id: "123" },
    });
  });
  it("a final provider receipt and succeeded status share one fenced checkpoint", async () => {
    const { ctx, store } = context();
    const write = vi.fn().mockResolvedValue({ id: "202" });
    await ctx.dispatch<{ id: string }>(
      "published",
      write,
      (r) => ({ media_id: r.id }),
      undefined,
      (r) => ({ media_id: r.id, permalink: null }),
    );
    expect(store.checkpoint).toHaveBeenCalledTimes(1);
    expect(store.checkpoint).toHaveBeenCalledWith(ctx.operation, {
      status: "succeeded",
      stage: "published",
      externalIds: { media_id: "202" },
      receipt: { media_id: "202", permalink: null },
    });
  });
  it("App Secret rotation refreshes the transport before another request", async () => {
    const { ctx, resolver } = context();
    const oldGraph = ctx.graph;
    resolver.mockResolvedValue({ ...resolved(), app: { ...app, appSecret: "rotated-secret" } });
    await ctx.beforeDispatch();
    expect(ctx.graph).not.toBe(oldGraph);
    expect(ctx.resolved.app.appSecret).toBe("rotated-secret");
  });
  it("revocation after a saved publish receipt skips optional enrichment and preserves success", async () => {
    const { ctx, store, op } = context();
    op.status = "succeeded";
    op.receipt = { media_id: "202", permalink: null };
    store.authorized.mockResolvedValue(false);
    const read = vi.fn();
    await ctx.enrichReceipt(read);
    expect(read).not.toHaveBeenCalled();
    expect(op.status).toBe("succeeded");
    expect(op.receipt.media_id).toBe("202");
  });
  it("a timeout after dispatch becomes uncertain and is not resent", async () => {
    const { ctx, store } = context();
    const write = vi.fn().mockRejectedValue(new Error("timeout token=secret"));
    await expect(ctx.dispatch("publish", write, () => ({ id: "1" }))).rejects.toBeInstanceOf(
      MetaExecutionInterrupted,
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.checkpoint).toHaveBeenCalledWith(
      ctx.operation,
      expect.objectContaining({ status: "uncertain", errorCode: "meta_dispatch_uncertain" }),
    );
    expect(JSON.stringify(store.checkpoint.mock.calls)).not.toContain("secret");
  });
  it("receipt and uncertainty persistence failures still bypass generic retry and keep the durable marker", async () => {
    const { ctx, store } = context();
    const write = vi.fn().mockResolvedValue({ id: "123" });
    store.checkpoint.mockRejectedValue(new Error("database unavailable"));
    await expect(
      ctx.dispatch<{ id: string }>("campaign", write, (result) => ({ campaign_id: result.id })),
    ).rejects.toBeInstanceOf(MetaExecutionInterrupted);
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.checkpoint).toHaveBeenCalledTimes(2);
    expect(store.checkpoint.mock.calls[1]?.[1]).toMatchObject({ status: "uncertain" });
  });
  it("a changed grant version or a Page extra guard stops before any POST", async () => {
    const { ctx, resolver, store } = context();
    resolver.mockResolvedValue({ ...resolved(), authorizationVersion: 2 });
    const write = vi.fn();
    await expect(ctx.dispatch("campaign", write, () => ({ id: "1" }))).rejects.toMatchObject({
      code: "meta_operation_not_authorized",
    });
    expect(store.beginDispatch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("safe DTO strips credentials, payload and arbitrary receipt fields", () => {
    const op = operation();
    op.request_payload = { url: "private-signed-url" };
    op.receipt = { campaign_id: "123", access_token: "secret", payload: "private" };
    expect(metaOperationDTO(op).receipt).toEqual({ campaign_id: "123" });
    expect(JSON.stringify(metaOperationDTO(op))).not.toContain("private");
  });
});
