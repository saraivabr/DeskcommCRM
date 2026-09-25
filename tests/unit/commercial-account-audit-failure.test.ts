import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ insert: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { SUPABASE_SERVICE_ROLE_KEY: "test-service-key" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert: mocks.insert }) }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
import { audit } from "@/lib/audit";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it.each(["rejected", "returned"])(
  "resolves and reports a %s commercial audit failure",
  async (mode) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    if (mode === "rejected") mocks.insert.mockRejectedValueOnce(new Error("write unavailable"));
    else mocks.insert.mockResolvedValueOnce({ error: { message: "write unavailable" } });
    await expect(
      audit({
        action: "platform_admin.commercial_account_updated",
        actorUserId: "11111111-1111-4111-8111-111111111111",
        organizationId: "22222222-2222-4222-8222-222222222222",
        actingAsPlatformAdmin: true,
        bypassedRls: true,
      }),
    ).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { subsystem: "audit", audit_action: "platform_admin.commercial_account_updated" },
        }),
      ),
    );
  },
);
