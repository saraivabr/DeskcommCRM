import { describe, it, expect } from "vitest";
import { draftInputSchema, parseBudgetCents } from "./schema";
import { draftReviewHash, imageReviewHash } from "./review";
const input = {
  id: "11111111-1111-4111-8111-111111111111",
  connection_id: "22222222-2222-4222-8222-222222222222",
  ad_account_asset_id: "33333333-3333-4333-8333-333333333333",
  page_asset_id: "44444444-4444-4444-8444-444444444444",
  name: "Campanha revisada",
  destination_url: "https://example.com/agenda",
  daily_budget_cents: 3500,
  currency: "BRL",
  starts_at: "2030-01-01T12:00:00Z",
  ends_at: "2030-01-08T12:00:00Z",
  creative: {
    studio_item_id: "55555555-5555-4555-8555-555555555555",
    message: "Conheça a agenda.",
    title: "Agenda disponível",
  },
};
describe("revisão e orçamento da campanha", () => {
  it("converte decimais exatos e rejeita arredondamento ou milhares ambíguos", () => {
    expect(parseBudgetCents("35,01")).toBe(3501);
    expect(parseBudgetCents("35.1")).toBe(3510);
    expect(parseBudgetCents("1000")).toBe(100000);
    for (const value of ["1,999", "1.000,00", "NaN", "-35", "1,00", "1000,01"])
      expect(parseBudgetCents(value)).toBeNull();
  });
  it("não aceita IDs remotos, moeda sem centavos, orçamento fracionado ou destino com credencial", () => {
    expect(draftInputSchema.safeParse(input).success).toBe(true);
    for (const changed of [
      { ad_account_asset_id: "act_123" },
      { currency: "JPY" },
      { daily_budget_cents: 3500.1 },
      { destination_url: "http://example.com" },
      { destination_url: "https://token@example.com" },
      { ends_at: "2030-02-15T12:00:00Z" },
    ])
      expect(draftInputSchema.safeParse({ ...input, ...changed }).success).toBe(false);
  });
  it("mantém hash estável por ordem de chaves e invalida revisão por orçamento, período ou imagem", () => {
    expect(draftReviewHash(input)).toBe(
      draftReviewHash(Object.fromEntries(Object.entries(input).reverse())),
    );
    for (const changed of [
      { daily_budget_cents: 3501 },
      { ends_at: "2030-01-09T12:00:00Z" },
      { creative: { ...input.creative, studio_item_id: "66666666-6666-4666-8666-666666666666" } },
    ])
      expect(draftReviewHash({ ...input, ...changed })).not.toBe(draftReviewHash(input));
    expect(imageReviewHash(Buffer.from("imagem aprovada"))).not.toBe(
      imageReviewHash(Buffer.from("imagem alterada")),
    );
  });
});
