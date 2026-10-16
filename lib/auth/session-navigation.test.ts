import { describe, expect, it, vi, afterEach } from "vitest";
import { isSessionExpired, loginForExpiredSession } from "./session-navigation";

afterEach(() => { vi.unstubAllGlobals(); });

describe("retorno seguro depois da expiração real", () => {
  it("preserva caminho, consulta e fragmento da mesma origem", () => {
    expect(loginForExpiredSession("/app/inbox?filter=mine#conversation")).toBe("/login?next=%2Fapp%2Finbox%3Ffilter%3Dmine%23conversation");
  });
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"])("recusa destino externo %s", (path) => {
    expect(loginForExpiredSession(path)).toBe("/login?next=%2Fapp");
  });
  it.each(["/login", "/login/mfa?next=/app", "/auth/callback"])("não cria laço em %s", (path) => {
    expect(loginForExpiredSession(path)).toBeNull();
  });
  it("somente um 401 de sessão decide login, nunca timeout, rate limit ou senha de provider", () => {
    expect(isSessionExpired(401, "unauthenticated")).toBe(true);
    expect(isSessionExpired(401, "token_expired")).toBe(true);
    expect(isSessionExpired(401, "invalid_credentials")).toBe(false);
    expect(isSessionExpired(401, "unauthorized")).toBe(false);
    expect(isSessionExpired(503, "auth_unavailable")).toBe(false);
    expect(isSessionExpired(504, "unauthenticated")).toBe(false);
  });
  it("coalesce 401 simultâneos em uma navegação", async () => {
    vi.resetModules();
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/app", search: "", hash: "", replace } });
    const { redirectExpiredSession } = await import("./session-navigation");
    redirectExpiredSession();
    redirectExpiredSession();
    expect(replace).toHaveBeenCalledExactlyOnceWith("/login?next=%2Fapp");
  });
});
