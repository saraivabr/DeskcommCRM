import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  user: vi.fn(),
  authorize: vi.fn(),
  configure: vi.fn(),
  status: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: h.user }));
vi.mock("@/lib/channels/meta/social/api", () => ({
  metaAuthorize: h.authorize,
  metaPublicOrigin: () => "https://crm.test",
  metaReadBody: (request: Request) => request.json(),
  metaAPIError: () => new Response(null, { status: 503 }),
}));
vi.mock("@/lib/channels/meta/social/messaging-store", () => ({
  configureMetaMessaging: h.configure,
  metaMessagingStatus: h.status,
}));
import { GET, POST } from "./route";
const actor = { organizationId: "tenant", actorId: "admin", sessionId: "session" };
const request = () =>
  new Request("https://crm.test/api/v1/integrations/meta/messaging", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "enable", asset_id: "11111111-1111-4111-8111-111111111111" }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  h.authorize.mockResolvedValue({ ok: true, actor });
  h.configure.mockResolvedValue({ enabled: true });
  h.status.mockResolvedValue({ channels: [] });
  h.user.mockResolvedValue({ support: null });
});
it("read-only support cannot activate or disable Direct even with an administrative role", async () => {
  h.user.mockResolvedValue({
    support: { status: "active", access_mode: "support_readonly", organization_id: "tenant" },
  });
  for (const action of ["enable", "disable"]) {
    const req = request();
    const body = await req.json();
    const response = await POST(
      new Request(req.url, { method: "POST", body: JSON.stringify({ ...body, action }) }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("forbidden");
  }
  expect(h.authorize).not.toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
});
it("unknown support permission fails closed before authorization and external effects", async () => {
  h.user.mockRejectedValue(new Error("auth unavailable"));
  expect((await POST(request())).status).toBe(503);
  expect(h.authorize).not.toHaveBeenCalled();
  expect(h.configure).not.toHaveBeenCalled();
});
it("ordinary authorized administrators retain the explicit activation flow", async () => {
  expect((await POST(request())).status).toBe(200);
  expect(h.authorize).toHaveBeenCalledWith(expect.any(Request), true);
  expect(h.configure).toHaveBeenCalledWith(
    actor,
    "11111111-1111-4111-8111-111111111111",
    "enable",
    "https://crm.test",
  );
});
it("read-only support still reads Direct status without a write effect", async () => {
  h.user.mockResolvedValue({ support: { status: "active", access_mode: "support_readonly" } });
  expect(
    (await GET(new Request("https://crm.test/api/v1/integrations/meta/messaging"))).status,
  ).toBe(200);
  expect(h.authorize).toHaveBeenCalledWith(expect.any(Request), false);
  expect(h.configure).not.toHaveBeenCalled();
});
