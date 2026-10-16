import { describe, expect, it, vi } from "vitest";
import { costCents } from "./pricing";
import { openAiCostCents } from "./openai-pricing";
import { meteredUsageCostCents } from "./catalog-pricing";
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
describe("tarifas oficiais de 2026-10-16 por requisição", () => {
  it("Haiku5.5 aplica a faixa longa ao prompt inteiro, incluindo cache", () => {
    expect(costCents("claude-haiku-5-5", { ...zero, inputTokens: 100_000 })).toBe(1);
    expect(costCents("claude-haiku-5-5", { ...zero, inputTokens: 100_001 })).toBeCloseTo(5.00005);
    expect(costCents("claude-haiku-5-5", { ...zero, inputTokens: 100_001, cacheReadTokens: 100_000 })).toBeCloseTo(0.50005);
  });
  it("cache Sol6.1 custa5% e contexto longo preserva2x entrada/1.5x saída", () => {
    expect(openAiCostCents("gpt-6.1-sol", { ...zero, inputTokens: 100_000, cacheReadTokens: 100_000 }, "default")).toBe(1);
    expect(openAiCostCents("gpt-6-luna", { ...zero, inputTokens: 300_000, outputTokens: 1_000 }, "default")).toBeCloseTo(6.075);
    expect(openAiCostCents("gpt-6-luna", { ...zero, inputTokens: 1 }, undefined)).toBeNull();
  });
  it("duas requisições curtas Haiku não viram uma requisição longa", async () => {
    const db = { query: vi.fn() } as never;
    const step = { usage: { ...zero, inputTokens: 60_000 }, serviceTier: "default" };
    expect(await meteredUsageCostCents(db, "anthropic", "claude-haiku-5-5", { steps: [step, step] } as never)).toBeCloseTo(1.2);
  });
});
