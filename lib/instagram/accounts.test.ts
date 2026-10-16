import type * as SocialClient from "@/lib/channels/social/client";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ native: vi.fn(), config: vi.fn(), accounts: vi.fn() }));
vi.mock("@/lib/channels/meta/social/instagram-read", () => ({
  listNativeInstagramReadAccounts: m.native,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/social/store", () => ({ readSocialIntegration: m.config }));
vi.mock("@/lib/channels/social/client", async (actual) => ({
  ...(await actual<typeof SocialClient>()),
  listSocialAccounts: m.accounts,
}));
import { SocialError } from "@/lib/channels/social/client";
import { instagramReadAccounts } from "./accounts";
beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockResolvedValue({ key: "private", profileId: "profile" });
});
it("keeps the native account and an actionable source error when billing blocks the other source", async () => {
  m.native.mockResolvedValue([{ id: "native", provider: "meta", name: "Store", active: true }]);
  m.accounts.mockRejectedValue(
    new SocialError("Confira a cobrança.", 402, 402, "social_payment_required"),
  );
  const result = await instagramReadAccounts("tenant");
  expect(result.accounts).toHaveLength(1);
  expect(result.provider_errors.legacy).toMatchObject({
    code: "social_payment_required",
    status: 402,
  });
  expect(JSON.stringify(result)).not.toContain("private");
});
it("propagates billing when there is no independent destination, rather than claiming disconnection", async () => {
  m.native.mockResolvedValue([]);
  m.accounts.mockRejectedValue(
    new SocialError("Confira a cobrança.", 402, 402, "social_payment_required"),
  );
  await expect(instagramReadAccounts("tenant")).rejects.toMatchObject({ status: 402 });
});
