import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  support: vi.fn(),
  query: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/requirePlatformAdmin", () => ({ requirePlatformAdmin: mocks.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: mocks.query }),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { GET, PATCH } from "@/app/api/v1/admin/tenants/[id]/commercial-account/route";
import { DEFAULT_COMMERCIAL_ACCOUNT } from "@/lib/billing/entitlements";
const id = "fd2f1e3a-8a26-4c07-8022-907dcb365f61";
const ctx = () => ({ params: Promise.resolve({ id }) });
const request = (method: string) =>
  new NextRequest(`https://test.invalid/api/v1/admin/tenants/${id}/commercial-account`, {
    method,
    ...(method === "PATCH" ? { body: JSON.stringify(DEFAULT_COMMERCIAL_ACCOUNT) } : {}),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue({ user: { id: "admin" }, platformAdmin: { scope: "full" } });
  mocks.support.mockResolvedValue(null);
  mocks.query.mockResolvedValue({ rows: [] });
});
it("denies non-admin reads before querying cross-tenant state", async () => {
  mocks.guard.mockRejectedValue(new Error("denied"));
  expect((await GET(request("GET"), ctx())).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("read-only platform admins cannot mutate classification", async () => {
  mocks.guard.mockResolvedValue({ user: { id: "admin" }, platformAdmin: { scope: "readonly" } });
  expect((await PATCH(request("PATCH"), ctx())).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("support readonly blocks effect despite full platform permissions", async () => {
  mocks.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await PATCH(request("PATCH"), ctx())).status).toBe(403);
  expect(mocks.query).not.toHaveBeenCalled();
});
it("full admin updates only path tenant and emits audit", async () => {
  expect((await PATCH(request("PATCH"), ctx())).status).toBe(200);
  expect(mocks.query.mock.calls[0]?.[1]?.[0]).toBe(id);
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      organizationId: id,
      actorUserId: "admin",
      action: "platform_admin.commercial_account_updated",
    }),
  );
});
