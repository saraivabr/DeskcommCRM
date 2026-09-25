import { describe, expect, it } from "vitest";
import { parseBusinessDraft, selectBusinessCases } from "./whatsapp-history-playbook";

const row = (id: string, contactId: string, direction: "inbound" | "outbound", body: string, intent: string | null = null) =>
  ({ id, contact_id: contactId, direction, body, intent, sent_at: new Date("2026-09-25T12:00:00Z") });

describe("playbook do histórico do WhatsApp", () => {
  it("seleciona conversas de mão dupla com sinal de atendimento e não inclui identificadores", () => {
    const rows = [
      row("m1", "cliente-a", "inbound", "Quanto custa o atendimento por mês?", "preco"),
      row("m2", "cliente-a", "outbound", "Vou explicar as opções que temos disponíveis."),
      row("m3", "cliente-a", "inbound", "Pode me passar uma proposta para minha equipe?", "informacao"),
      row("m4", "cliente-a", "outbound", "Podemos marcar uma conversa para entender seu caso."),
      row("m5", "cliente-b", "inbound", "Tudo bem com você hoje?", "outro"),
      row("m6", "cliente-b", "outbound", "Tudo certo e contigo?"),
      row("m7", "cliente-b", "inbound", "Também estou muito bem."),
      row("m8", "cliente-b", "outbound", "Que ótimo saber disso."),
    ];
    const selected = selectBusinessCases(rows, "BR");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.contactId).toBe("cliente-a");
    expect(selected[0]?.messageIds).toEqual(["m1", "m2", "m3", "m4"]);
    expect(selected[0]?.text).not.toContain("cliente-a");
  });

  it("rejeita um playbook sem duas conversas de evidência verificáveis", () => {
    const payload = JSON.stringify({ business: "Serviço", audience: "Empresas", offer: "Consultoria",
      journey: ["Entender a demanda"], questions: [], objections: [], tone: "Direto", unknowns: [], evidence: ["C1", "C9"] });
    expect(() => parseBusinessDraft(payload, ["C1", "C2"])).toThrow("history_playbook_insufficient_evidence");
    const valid = parseBusinessDraft(payload.replace('"C9"', '"C2"'), ["C1", "C2"]);
    expect(valid.evidenceIds).toEqual(["C1", "C2"]);
    expect(valid.content).toContain("## Jornada de atendimento observada");
  });

  it("identifica ofertas enviadas mesmo sem resposta, deduplica campanhas e exclui resumos automáticos", () => {
    const rows = [
      row("s1", "lead-a", "outbound", "Criei um sistema de atendimento com agentes de IA para empresas. Posso te mostrar uma demonstração?"),
      row("s2", "lead-b", "outbound", "Criei um sistema de atendimento com agentes de IA para empresas. Posso te mostrar uma demonstração?"),
      row("s3", "lead-c", "outbound", "Criamos páginas para negócios locais. Posso enviar um exemplo de site para a sua empresa?"),
      row("s4", "lead-d", "outbound", "🤖 Resumo da conversa: o cliente falou de atendimento, empresa e sistema de IA."),
      row("s5", "lead-e", "outbound", "Estamos combinando de nos encontrar com a família no sábado à tarde."),
    ];
    const selected = selectBusinessCases(rows, "BR");
    expect(selected).toHaveLength(2);
    expect(selected.map((item) => item.messageIds)).toEqual([["s1"], ["s3"]]);
    expect(selected.every((item) => item.kind === "offer")).toBe(true);
    expect(selected[0]?.text).toContain("Oferta enviada pela empresa");
  });

  it("rejeita negócio não identificado quando existem ofertas comprovadas", () => {
    const payload = JSON.stringify({ business: "não identificado", audience: "Empresas", offer: "não identificado",
      journey: [], questions: [], objections: [], tone: "Direto", unknowns: [], evidence: ["C1", "C2"] });
    expect(() => parseBusinessDraft(payload, ["C1", "C2"], true)).toThrow("history_playbook_business_not_identified");
  });
});
