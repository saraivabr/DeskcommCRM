import { afterEach, describe, expect, it, vi } from "vitest";
import { listSocialAccounts, socialRequest } from "./client";
afterEach(() => vi.unstubAllGlobals());
describe("social provider boundary", () => {
  it("filters upstream accounts by the configured profile and projects no credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accounts: [
              { _id: "a", platform: "instagram", isActive: true, profileId: { _id: "p" } },
              { _id: "b", platform: "facebook", isActive: true, profileId: "other" },
            ],
          }),
        ),
      ),
    );
    expect((await listSocialAccounts("test-key", "p")).map((a) => a._id)).toEqual(["a"]);
  });
  it("never includes upstream error bodies or credentials in errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret-body", { status: 403 })));
    await expect(socialRequest("test-key", "profiles")).rejects.toThrow("Acesso recusado");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
  });
});

it.each([
  [402, 402, "social_payment_required"],
  [401, 422, "social_reauthorization_required"],
  [403, 422, "social_reauthorization_required"],
  [429, 429, "rate_limited"],
  [503, 503, "social_unavailable"],
])(
  "maps provider status %s without confusing it with session expiry",
  async (upstream, status, code) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("private provider detail", { status: Number(upstream) })),
    );
    await expect(socialRequest("test-key", "accounts")).rejects.toMatchObject({
      status,
      code,
      upstreamStatus: upstream,
    });
    await expect(socialRequest("test-key", "accounts")).rejects.not.toThrow(
      "private provider detail",
    );
  },
);

it("preserves the partial PUT and idempotency headers; DELETE accepts an empty acknowledgement", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", request);
  await socialRequest(
    "key",
    "webhooks/settings",
    { webhookId: "owned", url: "https://crm.test/hook", isActive: true },
    { method: "PUT", requestId: "intent" },
  );
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    method: "PUT",
    headers: { "Idempotency-Key": "intent" },
    body: JSON.stringify({ webhookId: "owned", url: "https://crm.test/hook", isActive: true }),
  });
  await expect(
    socialRequest("key", "webhooks/settings?webhookId=owned", undefined, { method: "DELETE" }),
  ).resolves.toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
});

it("aborts provider reads when the caller cancels and makes no second request", async () => {
  const caller = new AbortController();
  const request = vi.fn().mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }),
  );
  vi.stubGlobal("fetch", request);
  const pending = expect(
    listSocialAccounts("key", "owned-profile", caller.signal),
  ).rejects.toMatchObject({ status: 503 });
  caller.abort();
  await pending;
  expect(request).toHaveBeenCalledOnce();
});
