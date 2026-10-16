import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser } }) }));
import { GET } from "./route";

beforeEach(() => getUser.mockReset());
describe("heartbeat HttpOnly", () => {
  it("confirma sessão sem devolver usuário ou tokens e desabilita cache", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "user" } }, error: null });
    const response = await GET(new NextRequest("https://app.example/api/v1/auth/session"));
    expect(await response.json()).toEqual({ data: { authenticated: true } });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it.each([503, 504])("erro %i não vira sessão ausente", async (status) => {
    getUser.mockResolvedValue({ data: { user: null }, error: { status } });
    const response = await GET(new NextRequest("https://app.example/api/v1/auth/session"));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("auth_unavailable");
  });
  it("sessão realmente ausente exige login", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } });
    const response = await GET(new NextRequest("https://app.example/api/v1/auth/session"));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthenticated");
  });
});
