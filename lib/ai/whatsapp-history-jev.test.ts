import { describe, expect, it, vi } from "vitest";
import { classifyHistoricalMessage, safeHistoricalState } from "./whatsapp-history-jev";

describe("Jev na análise de histórico", () => {
  it("remove dados pessoais antes de formar o estado externo", () => {
    const safe = safeHistoricalState("Meu telefone é (11) 99999-9999, quanto custa o serviço?", "BR");
    expect(safe).not.toContain("99999-9999");
    expect(safe).toContain("quanto custa");
  });

  it("chama a Decisions API e conserva somente rótulos tipados", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ answers: {
      intent: { type: "choice", choice: "preco", confidence: 0.93 },
      objection: { type: "choice", choice: "nenhuma", confidence: 0.88 },
    }, usage: { cost: 0.00002 } }), { status: 200 }));
    const result = await classifyHistoricalMessage("Quanto custa o serviço?", "test-key", request);
    expect(result).toEqual({ intent: "preco", objection: "nenhuma", confidence: 0.88, cost_usd: 0.00002 });
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
    const payload = JSON.parse(String(options.body));
    expect(payload.model).toBe("typesafe/jev-1.13");
    expect(payload.questions.intent.type).toBe("choice");
  });

  it("recusa rótulo fora do vocabulário e não inventa certeza", async () => {
    const invalid = vi.fn(async () => new Response(JSON.stringify({ answers: {
      intent: { type: "choice", choice: "venda_automatica", confidence: 1 },
      objection: { type: "choice", choice: "nenhuma", confidence: 1 },
    } }), { status: 200 }));
    await expect(classifyHistoricalMessage("Quero saber o preço", "test-key", invalid)).rejects.toThrow("jev_invalid_answer");
    const uncertain = vi.fn(async () => new Response(JSON.stringify({ answers: {
      intent: { type: "choice", choice: "preco", confidence: 0.51 },
      objection: { type: "choice", choice: "nenhuma", confidence: 0.94 },
    } }), { status: 200 }));
    expect((await classifyHistoricalMessage("Quero saber o preço", "test-key", uncertain)).intent).toBe("incerto");
  });
});
