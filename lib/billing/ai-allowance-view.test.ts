import { describe, expect, it, vi } from "vitest";
import { allowanceView, readAiAllowance } from "./ai-allowance-view";
const now = Date.parse("2026-09-20T12:00:00Z");
const row = {
  status: "active",
  current_period_start: "2026-09-01T00:00:00Z",
  current_period_end: "2026-10-01T00:00:00Z",
  budget: "3000",
  rate: "6",
  used: "123.50",
  reserved: "100",
  unknown_count: "0",
};
describe("commercial AI balance", () => {
  it("subtracts settled consumption and outstanding reservations in cents", () => {
    expect(allowanceView(row, now)).toMatchObject({
      status: "ready",
      remaining: 2776.5,
      used: 123.5,
      reserved: 100,
    });
  });
  it("does not infer an unconfirmed cycle", () => {
    expect(allowanceView({ ...row, current_period_start: null }, now)).toMatchObject({
      status: "unconfirmed",
      periodStart: null,
      periodEnd: null,
    });
  });
  it("flags unresolved charges instead of claiming spendable credit", () => {
    expect(allowanceView({ ...row, unknown_count: "1" }, now).status).toBe("review");
  });
  it.each(["pending", "past_due", "canceled"])("marks %s credit inactive", (status) => {
    expect(allowanceView({ ...row, status }, now).status).toBe("inactive");
  });
  it("expires exactly at the cycle boundary and does not activate future cycles", () => {
    expect(allowanceView(row, Date.parse(row.current_period_end)).status).toBe("inactive");
    expect(allowanceView(row, Date.parse(row.current_period_start) - 1).status).toBe("inactive");
  });
  it.each([{ budget: null }, { rate: "NaN" }, { used: "Infinity" }, { reserved: "-1" }])(
    "rejects corrupt financial data: %j",
    (patch) => {
      expect(() => allowanceView({ ...row, ...patch }, now)).toThrow(
        "Invalid AI allowance snapshot",
      );
    },
  );
});

it("omits an unconfigured disabled Free allowance without claiming a load failure", async () => {
  const query = vi
    .fn()
    .mockResolvedValue({
      rows: [
        {
          ...row,
          source: "free",
          status: "pending",
          budget: null,
          rate: null,
          current_period_start: null,
          current_period_end: null,
        },
      ],
    });
  await expect(readAiAllowance({ query }, "org-a")).resolves.toBeNull();
});

it.each([
  { source: "paid", status: "pending" },
  { source: "free", status: "active" },
])("still rejects missing financial data on %j", async (identity) => {
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [{ ...row, ...identity, budget: null, rate: null }] });
  await expect(readAiAllowance({ query }, "org-a")).rejects.toThrow(
    "Invalid AI allowance snapshot",
  );
});

it("separates supplier USD from commercial BRL and preserves pending operations", async () => {
  const { readAiUsageBreakdown } = await import("./ai-allowance-view");
  const { vi } = await import("vitest");
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        kind: "image",
        operations: "3",
        settled: "1",
        pending: "2",
        commercial: "50",
        reserved: "200",
        provider_cost: "12.25",
      },
    ],
  });
  expect(await readAiUsageBreakdown({ query }, "org-a")).toEqual([
    {
      kind: "image",
      operations: 3,
      settledOperations: 1,
      pendingOperations: 2,
      commercialUsedBrlCents: 50,
      reservedBrlCents: 200,
      knownProviderCostUsdCents: 12.25,
    },
  ]);
  expect(query.mock.calls[0]?.[1]).toEqual(["org-a"]);
});
it("rejects corrupt supplier costs instead of displaying a misleading total", async () => {
  const { readAiUsageBreakdown } = await import("./ai-allowance-view");
  const { vi } = await import("vitest");
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        kind: "voice",
        operations: "1",
        settled: "1",
        pending: "0",
        commercial: "0",
        reserved: "0",
        provider_cost: "NaN",
      },
    ],
  });
  await expect(readAiUsageBreakdown({ query }, "org-a")).rejects.toThrow(
    "Invalid AI usage snapshot",
  );
});
