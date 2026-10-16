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
