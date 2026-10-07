import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  resolve: vi.fn(),
  session: vi.fn(),
  last: "",
  before: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { last_inbound_at: mocks.last }, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("./messaging-store", () => ({
  META_SOCIAL_PROVIDER: "meta_social",
  messagingSession: mocks.session,
}));
vi.mock("./operations", () => ({ resolveSelectedMetaAsset: mocks.resolve }));
vi.mock("./graph", () => ({
  MetaGraphClient: class {
    request = mocks.request;
  },
}));
import { metaSocialAdapter } from "./messaging-adapter";
const envelope = {
  organizationId: "org",
  sessionRef: "10",
  to: "provider-thread",
  kind: "text" as const,
  body: "Resposta",
  providerConversationId: "20",
  beforeSend: mocks.before,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.last = new Date(Date.now() - 1000).toISOString();
  mocks.session.mockResolvedValue({
    id: "session",
    meta_social_asset_id: "asset",
    meta_social_connection_id: "connection",
    metadata: { social_platform: "instagram" },
  });
  mocks.resolve.mockResolvedValue({
    app: { appId: "1" },
    asset: { external_id: "10" },
    token: "private-token",
  });
  mocks.request.mockResolvedValue({ message_id: "m_1" });
});
describe("native replies through canonical outbound envelope", () => {
  it("sends a text reply using the current selected Page token and returns a namespaced receipt", async () => {
    await expect(metaSocialAdapter.send(envelope)).resolves.toEqual({ externalId: "meta:10:m_1" });
    expect(mocks.resolve).toHaveBeenCalledWith(
      "org",
      "asset",
      "instagram_message",
      "connection",
      expect.anything(),
    );
    expect(mocks.before).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledWith("10/messages", "private-token", {
      method: "POST",
      body: { recipient: '{"id":"20"}', message: '{"text":"Resposta"}' },
    });
  });
  it.each([
    "",
    new Date(Date.now() - 86401000).toISOString(),
    new Date(Date.now() + 10000).toISOString(),
  ])("never dispatches without a trustworthy 24h inbound window (%s)", async (last) => {
    mocks.last = last;
    await expect(metaSocialAdapter.send(envelope)).rejects.toThrow("24 horas");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("refuses unsolicited first messages and unsupported media", async () => {
    await expect(
      metaSocialAdapter.send({ ...envelope, providerConversationId: null }),
    ).rejects.toThrow("Aguarde");
    await expect(metaSocialAdapter.send({ ...envelope, kind: "image" })).rejects.toThrow("texto");
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not retry a timed-out or unconfirmed POST", async () => {
    mocks.request.mockRejectedValue(
      Object.assign(new Error("timeout"), { code: "meta_provider_unavailable" }),
    );
    await expect(metaSocialAdapter.send(envelope)).rejects.toThrow("sem confirmação");
    expect(mocks.request).toHaveBeenCalledOnce();
    mocks.request.mockReset().mockResolvedValue({ success: true });
    await expect(metaSocialAdapter.send(envelope)).rejects.toThrow("sem confirmação");
    expect(mocks.request).toHaveBeenCalledOnce();
  });
});

describe("native transport health", () => {
  it("detects a remotely removed subscription", async () => {
    mocks.request.mockResolvedValue({ data: [] });
    await expect(metaSocialAdapter.checkHealth!({ organizationId: "org", sessionRef: "10" })).resolves.toMatchObject({ reachable: true, status: "FAILED" });
    expect(mocks.request).toHaveBeenCalledWith("10/subscribed_apps", "private-token");
  });
  it("reports an inconclusive transport failure without claiming remote reachability", async () => {
    mocks.request.mockRejectedValue(new Error("network failure"));
    await expect(metaSocialAdapter.checkHealth!({ organizationId: "org", sessionRef: "10" })).resolves.toMatchObject({ reachable: false, status: null });
  });
});
