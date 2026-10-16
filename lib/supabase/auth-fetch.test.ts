// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { createAuthFetch } from "./auth-fetch";
import { isAuthUnavailable } from "@/lib/auth/availability";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("prazo de auth no transporte real do Supabase", () => {
  it("SDK real preserva cookie de sessão expirada quando refresh é abortado por indisponibilidade", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const setAll = vi.fn();
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const session = {
      access_token: "expired-access-token", refresh_token: "existing-refresh-token",
      token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) - 120,
      user: { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated" },
    };
    const cookie = { name: "sb-test-auth", value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}` };
    const client = createServerClient("https://auth.example", "anonymous-key", {
      global: { fetch: createAuthFetch(controller.signal) },
      cookieOptions: { name: cookie.name, httpOnly: true, path: "/", sameSite: "strict" },
      cookies: { getAll: () => [cookie], setAll },
    });
    const pending = client.auth.getUser();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new DOMException("Auth timed out", "TimeoutError"));
    // O SDK ainda pode consumir seu backoff interno. O sinal já abortado impede
    // qualquer I/O novo e seu erro retryable não chama _removeSession().
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await pending;
    expect(result.data.user).toBeNull();
    expect(result.error?.name).toBe("AuthRetryableFetchError");
    expect(isAuthUnavailable(result.error)).toBe(true);
    expect(setAll).not.toHaveBeenCalled();
    expect(cookie.value).toContain("base64-");
  });

  it("não impõe prazo de auth às escritas PostgREST comuns", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const boundedFetch = createAuthFetch();
    const controller = new AbortController();
    await boundedFetch("https://db.example/rest/v1/messages", { method: "POST", signal: controller.signal });
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(controller.signal);
  });

  it("prazo de leitura opt-in alcança permissões e RPC de acompanhamento", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const boundedFetch = createAuthFetch(controller.signal);
    await boundedFetch("https://db.example/rest/v1/rpc/fn_support_context", { method: "POST" });
    const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
    controller.abort();
    expect(signal.aborted).toBe(true);
    expect(boundedFetch.hasTimedOut()).toBe(true);
  });
});
