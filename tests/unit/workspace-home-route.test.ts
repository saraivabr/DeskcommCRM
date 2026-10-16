import type * as HomeModule from "@/lib/workspace/home";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fail } from "@/lib/api/wrappers";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), load: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.auth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/workspace/home", async (original) => ({
  ...(await original<typeof HomeModule>()),
  loadHomeOverview: mocks.load,
}));
import { GET } from "@/app/api/v1/workspace/home/route";
function request(query = "scope=team&days=7", signal?: AbortSignal) {
  return new NextRequest(`https://crm.example/api/v1/workspace/home?${query}`, { signal });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.mockResolvedValue("session-client");
  mocks.auth.mockResolvedValue({
    ok: true,
    org: { orgId: "trusted-org", role: "manager" },
    user: { id: "trusted-user" },
  });
  mocks.load.mockResolvedValue({ scope: "team" });
});
describe("consulta autenticada da Home", () => {
  it("exige manager para equipe e consulta com identidade do guard", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { scope: "team" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.auth).toHaveBeenCalledWith("manager", {
      resource: "workspace_home",
      requestId: expect.any(String),
    });
    expect(mocks.load).toHaveBeenCalledWith(
      "session-client",
      "trusted-org",
      "trusted-user",
      "manager",
      { scope: "team", days: 7 },
      undefined,
      expect.any(AbortSignal),
    );
  });
  it.each([401, 403, 503])("preserva a recusa %i antes de consultar", async (status) => {
    const response = fail(
      status === 503 ? "auth_unavailable" : "unauthenticated",
      "recusado",
      status,
    );
    mocks.auth.mockResolvedValue({ ok: false, response });
    expect(await GET(request())).toBe(response);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("recusa tenant forjado e período inválido sem consultar", async () => {
    expect((await GET(request("scope=mine&days=7&orgId=forged"))).status).toBe(400);
    expect((await GET(request("scope=mine&days=365"))).status).toBe(400);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("padrão pessoal exige viewer", async () => {
    await GET(request(""));
    expect(mocks.auth).toHaveBeenCalledWith("viewer", expect.any(Object));
    expect(mocks.load.mock.calls[0]![4]).toEqual({ scope: "mine", days: 7 });
  });
  it("não inicia consultas se o navegador cancelou enquanto autorizava", async () => {
    const controller = new AbortController();
    mocks.auth.mockImplementationOnce(async () => {
      controller.abort();
      return { ok: true, org: { orgId: "org", role: "manager" }, user: { id: "user" } };
    });
    expect((await GET(request(undefined, controller.signal))).status).toBe(503);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("propaga cancelamento para leituras em voo e retorna falha recuperável", async () => {
    const controller = new AbortController();
    mocks.load.mockImplementationOnce((...args: unknown[]) => {
      const signal = args[6] as AbortSignal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort();
      });
    });
    const response = await GET(request(undefined, controller.signal));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "service_unavailable" } });
  });
});
