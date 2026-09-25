import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: m.query }),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: m.error } }));
import {
  measuredTextUsage,
  measuredGenerationUsage,
  runMeteredOperation,
} from "@/lib/billing/metered-operation";
const identity = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  model: "test-model",
};
const result = { text: "Resposta", usage: { inputTokens: 1000, outputTokens: 500 } };
beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("fn_reserve_subscription_ai"))
      return { rows: [{ reservation_id: params[1] }] };
    if (sql.includes("from ai_models"))
      return {
        rows: [{ input_price_per_million_cents: 100, output_price_per_million_cents: 200 }],
      };
    return { rows: [] };
  });
});
it("reserves before invoking the provider and settles measured cost for the same company", async () => {
  const call = vi.fn(async () => {
    expect(m.query.mock.calls.some(([sql]) => sql.includes("fn_reserve_subscription_ai"))).toBe(
      true,
    );
    return result;
  });
  expect(await runMeteredOperation(identity, call, (r) => measuredTextUsage(r.usage))).toBe(result);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    0.2,
  ]);
});
it("quota rejection never invokes the provider", async () => {
  m.query.mockRejectedValueOnce(
    Object.assign(new Error("sensitive database detail"), { code: "P4021" }),
  );
  const call = vi.fn();
  await expect(runMeteredOperation(identity, call, () => null)).rejects.toMatchObject({
    name: "subscription_ai_allowance",
  });
  expect(call).not.toHaveBeenCalled();
});
it("legacy eligibility is serialized by the database before bypassing the ledger", async () => {
  m.query.mockResolvedValueOnce({ rows: [{ reservation_id: null }] });
  expect(
    await runMeteredOperation(
      identity,
      async () => result,
      () => null,
    ),
  ).toBe(result);
  expect(m.query).toHaveBeenCalledTimes(1);
});
it("provider failure holds unknown consumption and rethrows the original error", async () => {
  const original = new Error("provider failed");
  await expect(
    runMeteredOperation(
      identity,
      async () => {
        throw original;
      },
      () => null,
    ),
  ).rejects.toBe(original);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    null,
  ]);
});
it("missing usage is unknown, not zero", async () => {
  expect(measuredTextUsage(undefined)).toBeNull();
  expect(measuredTextUsage({ inputTokens: 1 })).toBeNull();
  await runMeteredOperation(
    identity,
    async () => result,
    () => null,
  );
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    null,
  ]);
});
it("database failure in settlement preserves the answer and logs the reservation for reconciliation", async () => {
  const original = m.query.getMockImplementation()!;
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("fn_settle_subscription_ai")) throw new Error("database unavailable");
    return original(sql, params);
  });
  expect(
    await runMeteredOperation(
      identity,
      async () => result,
      (r) => measuredTextUsage(r.usage),
    ),
  ).toBe(result);
  expect(m.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      organization_id: identity.organizationId,
      reservation_id: expect.any(String),
    }),
  );
});

it("does not charge a partial SDK aggregate when any step was unmeasured", async () => {
  const partial = {
    text: "Resposta preservada",
    usage: { inputTokens: 1000, outputTokens: 700 },
    steps: [result, { usage: { outputTokens: 200 } }],
  };
  expect(await runMeteredOperation(identity, async () => partial, measuredGenerationUsage)).toBe(
    partial,
  );
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    null,
  ]);
});

it("settles every measured step once, including cached tokens", async () => {
  const complete = {
    steps: [result, { usage: { inputTokens: 200, outputTokens: 100 } }],
  };
  await runMeteredOperation(identity, async () => complete, measuredGenerationUsage);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    0.24,
  ]);
  expect(
    measuredGenerationUsage({
      steps: [
        {
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            inputTokenDetails: { cacheReadTokens: 30, cacheWriteTokens: 40 },
          },
        },
        result,
      ],
    }),
  ).toEqual({ inputTokens: 1100, outputTokens: 520, cacheReadTokens: 30, cacheWriteTokens: 40 });
});

it("rejects invalid steps before an aggregate can conceal them", () => {
  for (const inputTokens of [-1, NaN, Infinity]) {
    expect(
      measuredGenerationUsage({ steps: [{ usage: { inputTokens, outputTokens: 0 } }, result] }),
    ).toBeNull();
  }
  expect(measuredGenerationUsage({ steps: [] })).toBeNull();
  expect(measuredGenerationUsage({ steps: [{}, result] })).toBeNull();
  expect(
    measuredGenerationUsage({
      steps: [
        {
          usage: {
            inputTokens: 1,
            outputTokens: 0,
            inputTokenDetails: { cacheReadTokens: 2 },
          },
        },
      ],
    }),
  ).toBeNull();
  expect(
    measuredGenerationUsage({
      steps: [1, 2].map(() => ({
        usage: {
          inputTokens: Number.MAX_VALUE,
          outputTokens: 0,
        },
      })),
    }),
  ).toBeNull();
});

it("preserves explicit zero and single-step adapters without step metadata", () => {
  expect(
    measuredGenerationUsage({ steps: [{ usage: { inputTokens: 0, outputTokens: 0 } }] }),
  ).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  expect(measuredGenerationUsage(result)).toEqual({
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

it("prices each direct SDK step before adding costs, preserving its actual tier", async () => {
  const { measuredGeneration } = await import("@/lib/billing/measured-usage");
  const response = {
    steps: ["default", "flex"].map((serviceTier) => ({
      usage: {
        inputTokens: 200000,
        outputTokens: 1000,
        inputTokenDetails: { cacheReadTokens: 100000 },
      },
      providerMetadata: { openai: { serviceTier } },
    })),
  };
  expect(
    await runMeteredOperation(
      { ...identity, model: "gpt-5.6-terra" },
      async () => response,
      measuredGeneration,
    ),
  ).toBe(response);
  // Both requests are short-context despite their aggregate input exceeding 272k.
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    34.8,
  ]);
});

it("holds the reservation when just one step has an unknown processing tier", async () => {
  const { measuredGeneration } = await import("@/lib/billing/measured-usage");
  const response = {
    steps: [{ ...result, providerMetadata: { openai: { serviceTier: "default" } } }, result],
  };
  expect(
    await runMeteredOperation(
      { ...identity, model: "gpt-5.6-terra" },
      async () => response,
      measuredGeneration,
    ),
  ).toBe(response);
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    null,
  ]);
});
it("records billing identity before egress and keeps response references", async () => {
  const call = vi.fn(async () => {
    expect(m.query).toHaveBeenCalledWith(
      "select fn_record_subscription_ai_evidence($1,$2,$3,$4,$5::jsonb)",
      [identity.organizationId, expect.any(String), identity.provider, identity.model, null],
    );
    return { response: { id: "resp_accounting" }, usage: { inputTokens: 1 } };
  });
  await runMeteredOperation(identity, call, () => null);
  const records = m.query.mock.calls.filter(([sql]) =>
    sql.includes("fn_record_subscription_ai_evidence"),
  );
  expect(records).toHaveLength(2);
  expect(JSON.parse(records[1]![1][4])).toMatchObject({
    steps: [{ responseId: "resp_accounting", inputTokens: 1, outputTokens: null }],
  });
});
it("does not call the provider when identity persistence fails", async () => {
  const original = m.query.getMockImplementation()!;
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("fn_record_subscription_ai_evidence")) throw new Error("storage unavailable");
    return original(sql, params);
  });
  const call = vi.fn();
  await expect(runMeteredOperation(identity, call, () => null)).rejects.toThrow(
    "storage unavailable",
  );
  expect(call).not.toHaveBeenCalled();
  expect(m.query).toHaveBeenCalledWith("select fn_settle_subscription_ai($1,$2,$3)", [
    identity.organizationId,
    expect.any(String),
    0,
  ]);
});
it("preserves the answer when final evidence persistence fails", async () => {
  const original = m.query.getMockImplementation()!;
  m.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("fn_record_subscription_ai_evidence") && params[4] !== null)
      throw new Error("secret detail");
    return original(sql, params);
  });
  await expect(
    runMeteredOperation(
      identity,
      async () => result,
      () => null,
    ),
  ).resolves.toBe(result);
  expect(m.error).toHaveBeenCalledWith("ai-allowance: usage evidence pending", {
    organization_id: identity.organizationId,
    reservation_id: expect.any(String),
  });
});

it("explicit Free accounts reserve even without a payment provider", async () => {
  await runMeteredOperation(
    identity,
    async () => result,
    (r) => measuredTextUsage(r.usage),
  );
  expect(m.query).toHaveBeenCalledWith(
    "select fn_reserve_subscription_ai($1,$2) as reservation_id",
    [identity.organizationId, expect.any(String)],
  );
});
it("disabled Free cannot silently become unmetered", async () => {
  m.query.mockRejectedValueOnce(Object.assign(new Error("disabled"), { code: "P4021" }));
  const provider = vi.fn();
  await expect(runMeteredOperation(identity, provider, () => null)).rejects.toMatchObject({
    name: "subscription_ai_allowance",
  });
  expect(provider).not.toHaveBeenCalled();
});
it("records text classification before provider egress", async () => {
  await runMeteredOperation(
    identity,
    async () => {
      expect(m.query).toHaveBeenCalledWith("select fn_record_subscription_ai_kind($1,$2,$3)", [
        identity.organizationId,
        expect.any(String),
        "text",
      ]);
      return result;
    },
    () => null,
  );
});
it("a missing classification migration fails before provider egress", async () => {
  m.query.mockRejectedValueOnce(
    Object.assign(new Error("relation org_commercial_accounts does not exist"), { code: "42P01" }),
  );
  const provider = vi.fn();
  await expect(runMeteredOperation(identity, provider, () => null)).rejects.toMatchObject({
    code: "42P01",
  });
  expect(provider).not.toHaveBeenCalled();
});

it("does not reach the provider until the serialized eligibility decision completes", async () => {
  let rejectDecision!: (reason: Error) => void;
  m.query.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectDecision = reject;
      }),
  );
  const provider = vi.fn();
  const operation = runMeteredOperation(identity, provider, () => null);
  const rejected = expect(operation).rejects.toMatchObject({ name: "subscription_ai_allowance" });
  expect(m.query).toHaveBeenCalledTimes(1);
  expect(m.query.mock.calls[0]?.[0]).toContain("fn_reserve_subscription_ai");
  expect(provider).not.toHaveBeenCalled();
  rejectDecision(Object.assign(new Error("Free activation disabled access"), { code: "P4021" }));
  await rejected;
  expect(provider).not.toHaveBeenCalled();
});
