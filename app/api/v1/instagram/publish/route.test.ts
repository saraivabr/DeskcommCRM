import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST, GET } from "./route";
import { LEGACY_INSTAGRAM_PUBLICATION_PROVIDER } from "@/lib/channels/social/instagram-publishing";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  support: vi.fn(),
  mfa: vi.fn(),
  queue: vi.fn(),
  accounts: vi.fn(),
  result: vi.fn(),
  config: vi.fn(),
  context: vi.fn(),
  read: vi.fn(),
  find: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: mocks.mfa }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/channels/meta/social/api", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  metaPublicOrigin: () => "https://app.test",
}));
vi.mock("@/lib/instagram/native-publication", () => ({
  queueNativeInstagramPublication: mocks.queue,
  listNativeInstagramAccounts: mocks.accounts,
  nativePublicationResult: mocks.result,
  publicationColumns: "id,provider",
}));
vi.mock("@/lib/channels/social/store", () => ({ readSocialIntegration: mocks.config }));
vi.mock("@/lib/channels/social/instagram-management", () => ({
  instagramContext: mocks.context,
  requireInstagramAccount: vi.fn(),
}));
vi.mock("@/lib/channels/social/instagram-publishing", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readInstagramPublication: mocks.read,
  findInstagramPublication: mocks.find,
  publishInstagram: vi.fn(),
}));
const ORG = "10000000-0000-4000-8000-000000000001";
const ID = "10000000-0000-4000-8000-000000000002";
const native = {
  id: ID,
  provider: "meta",
  meta_asset_id: ID,
  connection_id: ID,
  item_ids: [ID],
  format: "feed",
  caption: "Caption",
};
const request = (body = native, origin = "https://app.test") =>
  new Request("https://app.test/api/v1/instagram/publish", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("Instagram publication API discriminates immutable providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      ok: true,
      org: { orgId: ORG, role: "manager" },
      user: { id: ID },
    });
    mocks.support.mockResolvedValue(null);
    mocks.mfa.mockResolvedValue(false);
    mocks.queue.mockResolvedValue({ id: ID, status: "sending", provider: "meta" });
    mocks.config.mockResolvedValue(null);
    mocks.accounts.mockResolvedValue([]);
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.result.mockImplementation(async (_org, row) => ({ ...row, status: "uncertain" }));
  });
  it("queues a native intent with trusted tenant/actor and never calls legacy publish APIs", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.queue).toHaveBeenCalledWith(ORG, ID, native, expect.any(String));
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("cross-origin native mutation is denied before queue or provider discovery", async () => {
    expect((await POST(request(native, "https://evil.test"))).status).toBe(403);
    expect(mocks.queue).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("provider mixing and arbitrary external account IDs are rejected", async () => {
    expect((await POST(request({ ...native, account_id: "999" } as typeof native))).status).toBe(
      400,
    );
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("MFA and support guards stop native requests before intent preparation", async () => {
    mocks.mfa.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(403);
    expect(mocks.queue).not.toHaveBeenCalled();
    mocks.mfa.mockResolvedValue(false);
    mocks.support.mockResolvedValue(new Response("denied", { status: 403 }));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("native results work with no legacy configuration and inherit uncertain operation state", async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: ID, provider: "meta", status: "sending" }] });
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.publications[0].status).toBe("uncertain");
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("refreshing native results never reconciles them through the legacy account", async () => {
    mocks.config.mockResolvedValue({ key: "test" });
    mocks.context.mockResolvedValue({
      key: "test",
      profileId: "profile",
      accounts: [{ _id: "same", username: "tester", isActive: true }],
    });
    mocks.query.mockResolvedValue({
      rows: [{ id: ID, provider: "meta", account_id: "same", status: "pending" }],
    });
    const response = await GET();
    const body = await response.json();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.find).not.toHaveBeenCalled();
    expect(body.data.accounts[0].provider).toBe(LEGACY_INSTAGRAM_PUBLICATION_PROVIDER);
  });
  it("an unavailable legacy source leaves healthy native accounts visible with an explicit source error", async () => {
    mocks.config.mockResolvedValue({ key: "test" });
    mocks.context.mockRejectedValue(new Error("upstream unavailable"));
    mocks.accounts.mockResolvedValue([
      { id: ID, provider: "meta", connection_id: ID, active: true },
    ]);
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.accounts[0].provider).toBe("meta");
    expect(body.data.provider_errors.legacy).toEqual(expect.any(String));
    expect(body.data.provider_errors.native).toBeNull();
  });
  it("an unavailable native source leaves the legacy source visible", async () => {
    mocks.config.mockResolvedValue({ key: "test" });
    mocks.context.mockResolvedValue({
      accounts: [{ _id: "same", username: "tester", isActive: true }],
    });
    mocks.accounts.mockRejectedValue(new Error("native unavailable"));
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.accounts[0].provider).toBe(LEGACY_INSTAGRAM_PUBLICATION_PROVIDER);
    expect(body.data.provider_errors.native).toEqual(expect.any(String));
  });
  it("oversized publication JSON is rejected before any preparation", async () => {
    const response = await POST(request({ ...native, caption: "x".repeat(66000) }));
    expect(response.status).toBe(413);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});
