import { afterEach, beforeEach, expect, it, vi } from "vitest";
const redirect = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session-navigation", () => ({
  isSessionExpired: (status: number, code: string) => status === 401 && code === "unauthenticated",
  redirectExpiredSession: redirect,
}));
import { studioApi, STUDIO_READ_TIMEOUT_MS } from "./client";
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("aborts a stalled read within one total budget and then permits a successful retry", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
        ),
    );
  vi.stubGlobal("fetch", fetcher);
  const pending = expect(studioApi("/insights")).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(STUDIO_READ_TIMEOUT_MS + 1);
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockResolvedValue(new Response(JSON.stringify({ data: { connected: true } })));
  await expect(studioApi("/insights")).resolves.toEqual({ connected: true });
});
it("uses the canonical login recovery only for session401, not provider authentication", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Login" } }), {
        status: 401,
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(studioApi("/insights")).rejects.toMatchObject({ status: 401 });
  expect(redirect).toHaveBeenCalledOnce();
  fetcher.mockResolvedValue(
    new Response(
      JSON.stringify({ error: { code: "social_reauthorization_required", message: "Conexão" } }),
      { status: 422 },
    ),
  );
  await expect(studioApi("/insights")).rejects.toMatchObject({ status: 422 });
  expect(redirect).toHaveBeenCalledOnce();
});
it("does not repeat an unconfirmed publication even if the server returns503", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "service_unavailable", message: "Uncertain" } }),
        { status: 503 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    studioApi("/publish", { method: "POST", body: JSON.stringify({ id: "intent" }) }),
  ).rejects.toMatchObject({ status: 503 });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ id: "intent" });
});
