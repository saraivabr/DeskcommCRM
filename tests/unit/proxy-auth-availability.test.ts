import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUTH_TIMEOUT_MS } from "@/lib/auth/availability";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), rpc: vi.fn(), setAll: undefined as undefined | ((cookies: Array<{ name: string; value: string; options: object }>) => void),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: typeof mocks.setAll } }) => {
    mocks.setAll = options.cookies.setAll;
    return { auth: { getUser: mocks.getUser }, rpc: mocks.rpc };
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() } }));

import { proxy } from "@/proxy";

const sessionCookie = { name: "sb-deskcomm-auth", value: "renewed", options: { httpOnly: true, sameSite: "strict", path: "/" } };
function request(path: string) {
  return new NextRequest(`https://app.example${path}`, { headers: { cookie: "sb-deskcomm-auth=original" } });
}

beforeEach(() => {
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: "user" } }, error: null });
  mocks.rpc.mockReset().mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.useRealTimers());

describe("proxy — indisponibilidade não expira sessão", () => {
  it.each([429, 500, 502, 503, 504])("auth %i bloqueia com 503, preserva cookie e não manda ao login", async (status) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status, name: "AuthApiError" } });
    const response = await proxy(request("/api/v1/workspace/home"));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("auth_unavailable");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("navegação com falha tem HTML recuperável na mesma URL, sem acesso a dados", async () => {
    mocks.getUser.mockRejectedValue(new TypeError("fetch failed"));
    const response = await proxy(request("/app/inbox?filter=mine"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain('href="/app/inbox?filter=mine"');
    expect(response.headers.get("location")).toBeNull();
  });

  it("prazo encerra verificação pendurada e ignora remoção tardia de cookie", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    mocks.getUser.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = proxy(request("/api/v1/workspace/home"));
    await vi.advanceTimersByTimeAsync(AUTH_TIMEOUT_MS + 1);
    const response = await pending;
    expect(response.status).toBe(503);
    mocks.setAll!([{ ...sessionCookie, value: "", options: { maxAge: 0 } }]);
    finish({ data: { user: null }, error: { status: 504 } });
    await Promise.resolve();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refresh chega ao handler e ao browser com atributos de segurança", async () => {
    mocks.getUser.mockImplementation(async () => {
      mocks.setAll!([sessionCookie]);
      return { data: { user: { id: "user" } }, error: null };
    });
    const response = await proxy(request("/api/v1/workspace/home"));
    expect(response.headers.get("x-middleware-request-cookie")).toContain("sb-deskcomm-auth=renewed");
    expect(response.headers.get("x-middleware-request-x-pathname")).toBe("/api/v1/workspace/home");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=strict");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each(["/app/inbox?filter=mine", "/api/v1/workspace/home"])("sessão inválida preserva remoção de cookie em %s", async (path) => {
    mocks.getUser.mockImplementation(async () => {
      mocks.setAll!([{ ...sessionCookie, value: "", options: { path: "/", maxAge: 0 } }]);
      return { data: { user: null }, error: { status: 401, name: "AuthApiError" } };
    });
    const response = await proxy(request(path));
    expect(response.status).toBe(path.startsWith("/api/") ? 401 : 307);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    if (path.startsWith("/app")) expect(new URL(response.headers.get("location")!).searchParams.get("next")).toBe(path);
  });

  it("redirecionamento de admin preserva refresh; erro de banco retorna503 sem rebaixar", async () => {
    mocks.getUser.mockImplementation(async () => {
      mocks.setAll!([sessionCookie]);
      return { data: { user: { id: "user" } }, error: null };
    });
    mocks.rpc.mockResolvedValueOnce({ data: false, error: null });
    const forbidden = await proxy(request("/admin"));
    expect(forbidden.headers.get("location")).toBe("https://app.example/admin/forbidden");
    expect(forbidden.cookies.get("sb-deskcomm-auth")?.value).toBe("renewed");
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST002" } });
    const unavailable = await proxy(request("/admin"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("location")).toBeNull();
  });

  it("503 após refresh mantém lote completo, inclusive remoção de chunk antigo", async () => {
    mocks.getUser.mockImplementation(async () => {
      mocks.setAll!([
        { ...sessionCookie, name: "sb-deskcomm-auth.0", value: "fresh-chunk" },
        { ...sessionCookie, name: "sb-deskcomm-auth.1", value: "", options: { path: "/", maxAge: 0 } },
      ]);
      return { data: { user: { id: "user" } }, error: null };
    });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST002" } });
    const response = await proxy(request("/admin"));
    expect(response.status).toBe(503);
    expect(response.cookies.get("sb-deskcomm-auth.0")?.value).toBe("fresh-chunk");
    expect(response.cookies.get("sb-deskcomm-auth.1")?.maxAge).toBe(0);
  });

  it("503 com remoção pura não apaga sessão e retry nunca sai da origem", async () => {
    mocks.getUser.mockImplementation(async () => {
      mocks.setAll!([{ ...sessionCookie, value: "", options: { path: "/", maxAge: 0 } }]);
      return { data: { user: null }, error: { status: 503 } };
    });
    const response = await proxy(request("//evil.example"));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain('href="/app"');
  });

  it("callbacks públicos mantêm seu guard próprio", async () => {
    expect((await proxy(request("/auth/callback?code=example"))).status).toBe(200);
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});
