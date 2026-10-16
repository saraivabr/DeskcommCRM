import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  request: vi.fn(),
  status: vi.fn(),
  assets: vi.fn(),
}));
vi.mock("./operations", () => ({ resolveSelectedMetaAsset: mocks.resolve }));
vi.mock("./bounded-admin", () => ({ createBoundedMetaAdminClient: () => ({}) }));
vi.mock("./store", () => ({ MetaConnectionStore: class {} }));
vi.mock("./service", () => ({
  MetaNativeService: class {
    status = mocks.status;
    assets = mocks.assets;
  },
}));
vi.mock("./graph", () => ({
  MetaGraphClient: class {
    request = mocks.request;
  },
}));
import { nativeInstagramInsights, listNativeInstagramReadAccounts } from "./instagram-read";
const ID = "10000000-0000-4000-8000-000000000001";
const CONNECTION = "10000000-0000-4000-8000-000000000002";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ asset: { external_id: "178" }, token: "private", app: {} });
});
describe("native Instagram read contract", () => {
  it("selects the current tenant/grant explicitly and reads totals without daily unique reach addition", async () => {
    mocks.request.mockResolvedValue({
      data: [
        { name: "reach", id: "178/insights/reach/day", total_value: { value: 42 } },
        { name: "views" },
      ],
    });
    const result = await nativeInstagramInsights(
      "tenant",
      { account_id: ID, connection_id: CONNECTION },
      undefined,
      new Date("2026-10-16T00:00:00Z"),
    );
    expect(mocks.resolve).toHaveBeenCalledWith("tenant", ID, "instagram_insights", CONNECTION, {});
    expect(mocks.request).toHaveBeenCalledWith(
      "178/insights",
      "private",
      expect.objectContaining({
        query: expect.objectContaining({
          period: "day",
          metric_type: "total_value",
          metric: "reach,views,accounts_engaged,total_interactions",
          since: "1789516800",
          until: "1792108800",
        }),
      }),
    );
    expect(result.metrics).toEqual({ reach: { total: 42 } });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not contact Graph when the selected grant is revoked or belongs to another tenant", async () => {
    mocks.resolve.mockRejectedValue(new Error("denied"));
    await expect(
      nativeInstagramInsights("other", { account_id: ID, connection_id: CONNECTION }),
    ).rejects.toThrow("denied");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it.each([
    { data: [{ name: "reach", id: "999/insights/reach/day", total_value: { value: 42 } }] },
    { data: [{ name: "reach", total_value: { value: -1 } }] },
    { data: [{ name: "reach", total_value: { value: null } }] },
  ])("rejects mismatched identity or malformed numbers", async (payload) => {
    mocks.request.mockResolvedValue(payload);
    await expect(
      nativeInstagramInsights("tenant", { account_id: ID, connection_id: CONNECTION }),
    ).rejects.toMatchObject({ code: "meta_provider_response_invalid" });
  });
  it("only lists selected healthy native accounts, independently of publication permission", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connections: [
        { id: CONNECTION, status: "healthy", reconnect_required: false },
        { id: "revoked", status: "revoked" },
      ],
    });
    mocks.assets.mockResolvedValue({
      assets: [
        {
          id: ID,
          kind: "instagram",
          selected: true,
          name: "Store",
          capabilities: {
            instagram_read: true,
            instagram_insights: true,
            instagram_publish: false,
          },
        },
        {
          id: "unselected",
          kind: "instagram",
          selected: false,
          capabilities: { instagram_read: true },
        },
      ],
    });
    expect(await listNativeInstagramReadAccounts("tenant")).toEqual([
      {
        id: ID,
        provider: "meta",
        connection_id: CONNECTION,
        name: "Store",
        active: true,
        insights_available: true,
      },
    ]);
    expect(mocks.assets).toHaveBeenCalledTimes(1);
  });
});
