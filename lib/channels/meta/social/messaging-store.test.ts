import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ request: vi.fn(), resolve: vi.fn(), update: vi.fn() }));
vi.mock("./api", () => ({ metaPublicOrigin: () => "https://produto.example" }));
vi.mock("./operations", () => ({ resolveSelectedMetaAsset: mocks.resolve }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("./graph", () => ({
  MetaGraphClient: class {
    request = mocks.request;
  },
}));
import { configureMetaMessaging } from "./messaging-store";
const actor = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  actorId: "10000000-0000-4000-8000-000000000002",
  sessionId: "10000000-0000-4000-8000-000000000003",
};
const row = {
  id: "10000000-0000-4000-8000-000000000004",
  organization_id: actor.organizationId,
  meta_social_asset_id: "10000000-0000-4000-8000-000000000005",
  meta_social_connection_id: "10000000-0000-4000-8000-000000000006",
  meta_social_external_id: "10",
  status: "STOPPED",
  updated_at: "2026-01-01T00:00:00Z",
  metadata: { social_platform: "facebook" },
};
function database() {
  return {
    from: (table: string) => {
      let changed = false;
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        update: (value: unknown) => {
          changed = true;
          mocks.update(value);
          return q;
        },
        maybeSingle: async () => ({
          data: table === "meta_assets" ? { kind: "page" } : changed ? { id: row.id } : row,
          error: null,
        }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data: [{ ...row, status: "WORKING" }], error: null })),
      };
      return q;
    },
  };
}
const fields = [
  "messages",
  "messaging_postbacks",
  "message_echoes",
  "message_deliveries",
  "message_reads",
];
function appSubscription(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    active: true,
    callback_url: "https://produto.example/api/v1/webhooks/meta-social",
    fields: fields.map((name) => ({ name })),
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    app: { appId: "1", appSecret: "synthetic-private-app-secret" },
    connectionId: row.meta_social_connection_id,
    asset: { external_id: "10", name: "Page" },
    token: "synthetic-page-token",
  });
});
describe("native activation verifies the global callback before any channel or Page mutation", () => {
  it.each([
    {
      data: [
        appSubscription({
          callback_url: "https://52cv7zdc64autz4ltjj6h7uce40ktyfd.lambda-url.us-east-1.on.aws/",
        }),
      ],
    },
    { data: [] },
    { data: [appSubscription({ active: false })] },
    { data: [appSubscription({ fields: [{ name: "messages" }] })] },
  ])("fails closed for wrong, absent, inactive or incomplete destinations", async (response) => {
    mocks.request.mockResolvedValue(response);
    await expect(
      configureMetaMessaging(
        actor,
        row.meta_social_asset_id,
        "enable",
        "https://produto.example",
        database() as never,
      ),
    ).rejects.toMatchObject({ code: "meta_messaging_callback_mismatch", status: 409 });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith(
      "1/subscriptions",
      "1|synthetic-private-app-secret",
      { appToken: true },
    );
  });
  it("only subscribes the Page after a current active canonical app callback and verifies the readback", async () => {
    mocks.request
      .mockResolvedValueOnce({ data: [appSubscription()] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ data: [{ id: "1", subscribed_fields: fields }] });
    const state = await configureMetaMessaging(
      actor,
      row.meta_social_asset_id,
      "enable",
      "https://produto.example",
      database() as never,
    );
    expect(state.channels[0]?.status).toBe("WORKING");
    expect(mocks.request.mock.calls.map((call) => [call[0], call[2]?.method ?? "GET"])).toEqual([
      ["1/subscriptions", "GET"],
      ["10/subscribed_apps", "GET"],
      ["10/subscribed_apps", "POST"],
      ["10/subscribed_apps", "GET"],
    ]);
  });
});
