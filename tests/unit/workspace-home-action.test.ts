import type * as HomeModule from "@/lib/workspace/home";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), load: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/workspace/home", async (original) => ({
  ...(await original<typeof HomeModule>()),
  loadHomeOverview: mocks.load,
}));
import { getHomeOverview } from "@/app/app/_home-action";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.mockResolvedValue("session-client");
  mocks.auth.mockResolvedValue({
    ok: true,
    org: { orgId: "trusted-org", role: "manager" },
    user: { id: "trusted-user" },
  });
  mocks.load.mockResolvedValue({});
});
describe("autorização Home", () => {
  it("exige manager no servidor para equipe e usa identidade do guard", async () => {
    await getHomeOverview({ scope: "team", days: 7 });
    expect(mocks.auth).toHaveBeenCalledWith("manager", { resource: "workspace_home" });
    expect(mocks.load).toHaveBeenCalledWith(
      "session-client",
      "trusted-org",
      "trusted-user",
      "manager",
      { scope: "team", days: 7 },
    );
  });
  it("nega antes da consulta quando guard recusa", async () => {
    mocks.auth.mockResolvedValue({ ok: false });
    expect((await getHomeOverview({ scope: "team", days: 30 })).ok).toBe(false);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("recusa tentativa de escolher outra organização no input", async () => {
    expect((await getHomeOverview({ scope: "mine", days: 7, orgId: "forged" })).ok).toBe(false);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
