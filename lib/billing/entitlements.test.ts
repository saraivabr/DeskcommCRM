import { describe, expect, it, vi } from "vitest";
import {
  commercialAccountSchema,
  DEFAULT_COMMERCIAL_ACCOUNT,
  readCommercialAccount,
} from "./entitlements";
describe("closed Free activation", () => {
  it("keeps unclassified existing accounts unconverted", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    expect(await readCommercialAccount({ query }, "org")).toEqual(DEFAULT_COMMERCIAL_ACCOUNT);
    expect(query.mock.calls[0]?.[1]).toEqual(["org"]);
  });
  it("rejects activation without explicit tariff, period and capacities", () => {
    expect(
      commercialAccountSchema.safeParse({
        ...DEFAULT_COMMERCIAL_ACCOUNT,
        classification: "free_public",
        free_enabled: true,
      }).success,
    ).toBe(false);
  });
  it("allows a configured beta with zero channels and zero published agents", () => {
    const account = {
      ...DEFAULT_COMMERCIAL_ACCOUNT,
      classification: "free_public",
      free_enabled: true,
      free_seats: 1,
      free_channels: 0,
      free_agents: 0,
      free_ai_credit_cents: 200,
      free_ai_usd_to_brl_rate: 6,
      free_period_start: "2026-09-01T00:00:00.000Z",
      free_period_end: "2026-10-01T00:00:00.000Z",
    };
    expect(commercialAccountSchema.safeParse(account).success).toBe(true);
    expect(
      commercialAccountSchema.safeParse({ ...account, classification: "courtesy" }).success,
    ).toBe(false);
    expect(
      commercialAccountSchema.safeParse({ ...account, free_period_end: account.free_period_start })
        .success,
    ).toBe(false);
    expect(
      commercialAccountSchema.safeParse({ ...account, free_ai_usd_to_brl_rate: Infinity }).success,
    ).toBe(false);
  });
});
