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
});
