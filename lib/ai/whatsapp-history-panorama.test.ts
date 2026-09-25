import { describe, expect, it } from "vitest";
import { summarizeWhatsappHistory } from "./whatsapp-history-panorama";

describe("panorama de conversas importadas", () => {
  it("mostra somente perguntas recorrentes anonimizadas, sem elevar fala isolada a regra", () => {
    const result = summarizeWhatsappHistory([
      { direction: "inbound", body: "Qual é o horário de atendimento?" },
      { direction: "inbound", body: "Qual é o horário de atendimento?" },
      { direction: "inbound", body: "Meu CPF é 123.456.789-00?" },
      { direction: "outbound", body: "Atendemos das 9 às 18." },
    ]);
    expect(result).toEqual({
      inbound: 3, outbound: 1,
      questions: [{ question: "qual é o horário de atendimento", count: 2 }],
    });
  });
});
