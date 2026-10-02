// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  pool: { query: vi.fn() },
  admin: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  ensure: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.support }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => mocks.pool }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/prospecting/default-seller", () => ({
  loadStandardSellerProfile: mocks.load,
  saveStandardSellerProfile: mocks.save,
  ensureStandardProspectingSeller: mocks.ensure,
}));
vi.mock("@/lib/prospecting/store", () => ({
  activateCampaign: vi.fn(),
  configureCredential: vi.fn(),
  createSearch: vi.fn(),
  validateConfig: vi.fn(),
  withProspectingLock: vi.fn(),
}));
vi.mock("@/lib/prospecting/schedule", () => ({
  enableSchedule: vi.fn(),
  saveSchedule: vi.fn(),
  stopSchedule: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
import { GET, POST } from "@/app/api/v1/prospecting/route";
import { ProspectingError } from "@/lib/prospecting/provider";

const org = "10000000-0000-4000-8000-000000000001";
const profile = {
  seller_name: "Marina",
  company_name: "Minha empresa",
  offer: "Organizar contatos e acompanhar interessados",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockResolvedValue({ ok: true, user: { id: "user" }, org: { orgId: org } });
  mocks.support.mockResolvedValue(null);
  mocks.pool.query.mockResolvedValue({ rows: [] });
  mocks.load.mockResolvedValue(profile);
  mocks.save.mockResolvedValue(profile);
  mocks.audit.mockResolvedValue(undefined);
});

describe("prospecting organization seller API", () => {
  it("returns the seller profile without provisioning from GET", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).data.seller).toEqual(profile);
    expect(mocks.load).toHaveBeenCalledWith(mocks.pool, org);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("saves only under the authenticated organization and audits the explicit operation", async () => {
    const response = await POST(
      new Request("https://example.com/api/v1/prospecting", {
        method: "POST",
        body: JSON.stringify({ action: "save_seller", profile }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ seller: profile });
    expect(mocks.save).toHaveBeenCalledWith(mocks.pool, org, profile);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.changed",
        organizationId: org,
        actorUserId: "user",
        metadata: { operation: "save_seller" },
      }),
    );
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it.each([
    { action: "save_seller", profile: { ...profile, offer: "" } },
    { action: "save_seller", profile, organization_id: "another-org" },
  ])("rejects invalid or client-selected tenant input before writes", async (body) => {
    const response = await POST(
      new Request("https://example.com/api/v1/prospecting", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(422);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("blocks support writes before resolving the organization or saving", async () => {
    mocks.support.mockResolvedValue(new Response("forbidden", { status: 403 }));
    expect(
      (
        await POST(
          new Request("https://example.com/api/v1/prospecting", {
            method: "POST",
            body: JSON.stringify({ action: "save_seller", profile }),
          }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns a profile save error without reporting successful audit", async () => {
    mocks.save.mockRejectedValue(new ProspectingError("Empresa não encontrada.", 404));
    const response = await POST(
      new Request("https://example.com/api/v1/prospecting", {
        method: "POST",
        body: JSON.stringify({ action: "save_seller", profile }),
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.message).toBe("Empresa não encontrada.");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
