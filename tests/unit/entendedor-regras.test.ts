import { describe, expect, it } from "vitest";

import { comporNota, duracaoPorExtenso, RECOLHER_NO_LER_MAIS } from "@/lib/entendedor/composicao";
import {
  FRANQUIA_GRATIS_SEGUNDOS,
  inicioDoPeriodo,
  inicioDoProximoPeriodo,
  limiteDaOrganizacao,
  segundosCobraveis,
} from "@/lib/entendedor/franquia";
import { CONFIGURACAO_PADRAO, decidirSeEntende } from "@/lib/entendedor/politica";
import { promptDoSistema, promptDoUsuario } from "@/lib/entendedor/prompt";

describe("franquia do entendedor", () => {
  it("é de 30 minutos por mês quando a organização não tem limite próprio", () => {
    expect(FRANQUIA_GRATIS_SEGUNDOS).toBe(1800);
    expect(limiteDaOrganizacao(null)).toBe(1800);
    expect(limiteDaOrganizacao(undefined)).toBe(1800);
  });

  it("valor inválido cai no padrão, nunca em ilimitado", () => {
    expect(limiteDaOrganizacao(-1)).toBe(1800);
    expect(limiteDaOrganizacao(12.5)).toBe(1800);
    expect(limiteDaOrganizacao(0)).toBe(0);
    expect(limiteDaOrganizacao(9000)).toBe(9000);
  });

  it("o mês é o de São Paulo, não o de UTC", () => {
    // 01/11 01:00 UTC ainda é 31/10 22:00 em São Paulo.
    expect(inicioDoPeriodo(new Date("2026-11-01T01:00:00Z"))).toBe("2026-10-01");
    expect(inicioDoPeriodo(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11-01");
  });

  it("renova no primeiro dia do mês seguinte, inclusive na virada do ano", () => {
    expect(inicioDoProximoPeriodo(new Date("2026-10-17T12:00:00Z"))).toBe("2026-11-01");
    expect(inicioDoProximoPeriodo(new Date("2026-12-20T12:00:00Z"))).toBe("2027-01-01");
  });

  it("cobra o segundo começado e recusa duração ausente", () => {
    expect(segundosCobraveis(0.4)).toBe(1);
    expect(segundosCobraveis(19)).toBe(19);
    expect(segundosCobraveis(0)).toBeNull();
    expect(segundosCobraveis(Number.NaN)).toBeNull();
    expect(segundosCobraveis(undefined)).toBeNull();
  });
});

describe("política do entendedor", () => {
  const ligado = { ...CONFIGURACAO_PADRAO, enabled: true };

  it("nasce desligado", () => {
    expect(decidirSeEntende(CONFIGURACAO_PADRAO, { direction: "inbound", isGroup: false })).toEqual({
      processa: false,
      motivo: "desligado",
    });
  });

  it("ligado, entende o recebido e não o enviado", () => {
    expect(decidirSeEntende(ligado, { direction: "inbound", isGroup: false })).toEqual({ processa: true });
    expect(decidirSeEntende(ligado, { direction: "outbound", isGroup: false })).toEqual({
      processa: false,
      motivo: "direcao_desligada",
    });
  });

  it("grupo fica de fora por padrão", () => {
    expect(decidirSeEntende(ligado, { direction: "inbound", isGroup: true })).toEqual({
      processa: false,
      motivo: "grupo_desligado",
    });
  });

  it("sem nenhuma saída ligada não processa (e não cobra)", () => {
    const nada = { ...ligado, show_understanding: false, show_spoken_text: false };
    expect(decidirSeEntende(nada, { direction: "inbound", isGroup: false })).toEqual({
      processa: false,
      motivo: "nenhuma_saida",
    });
  });
});

describe("nota do entendedor", () => {
  const base = {
    segundos: 45,
    quemFalou: "Ana",
    entendimento: {
      category: "short" as const,
      intent: "pedir" as const,
      focus: "valor",
      key_sentence: "Ana pergunta se o valor combinado está de pé.",
      message: "Quer saber se você topa o valor que conversaram.",
      points: [],
      decisions: [],
      next_steps: [],
      requests: [],
    },
    textoFalado: "Oi, tudo bem? Você topa aquele valor?",
    mostrarEntendimento: true,
    mostrarTextoFalado: true,
    marca: "Marca de Teste",
  };

  it("duração com plural certo — o fluxo antigo escrevia '1 minuto e 1 segundos'", () => {
    expect(duracaoPorExtenso(1)).toBe("1 segundo");
    expect(duracaoPorExtenso(45)).toBe("45 segundos");
    expect(duracaoPorExtenso(60)).toBe("1 minuto");
    expect(duracaoPorExtenso(61)).toBe("1 minuto e 1 segundo");
    expect(duracaoPorExtenso(125)).toBe("2 minutos e 5 segundos");
  });

  it("monta cabeçalho, entendimento, o que foi dito e assinatura da marca", () => {
    const nota = comporNota(base)!;
    expect(nota.startsWith("🤖 *economizei 45 segundos do seu tempo* 👇\n")).toBe(true);
    expect(nota).toContain(RECOLHER_NO_LER_MAIS);
    expect(nota).toContain("🎯 *Ana:* Quer saber se você topa o valor que conversaram.");
    expect(nota).toContain("📄 *O que foi dito*\nOi, tudo bem? Você topa aquele valor?");
    expect(nota.endsWith("_explicado por *Marca de Teste*_")).toBe(true);
  });

  it("nunca chama o bloco de 'Transcrição'", () => {
    expect(comporNota(base)).not.toMatch(/transcri/i);
  });

  it("fala simples usa o balão; nome repetido no começo é cortado", () => {
    const nota = comporNota({
      ...base,
      entendimento: { ...base.entendimento, category: "simple", message: "Ana disse que chega às 8h." },
    })!;
    expect(nota).toContain("💬 *Ana:* disse que chega às 8h.");
  });

  it("frase genérica ('o remetente…') cai no resumo factual", () => {
    const nota = comporNota({
      ...base,
      entendimento: { ...base.entendimento, message: "O remetente pergunta sobre o valor." },
    })!;
    // E o nome repetido no começo do resumo também é cortado.
    expect(nota).toContain("*Ana:* pergunta se o valor combinado está de pé.");
  });

  it("marcação do modelo não vaza para o WhatsApp", () => {
    const nota = comporNota({
      ...base,
      entendimento: { ...base.entendimento, message: "*Urgente*: _paga_ hoje\ncom ~desconto~" },
    })!;
    expect(nota).toContain("*Ana:* Urgente: paga hoje com desconto");
  });

  it("sem nada para mostrar não manda mensagem vazia", () => {
    expect(comporNota({ ...base, entendimento: null, mostrarTextoFalado: false })).toBeNull();
  });

  it("só o que foi dito também funciona — o fluxo antigo quebrava neste caso", () => {
    const nota = comporNota({ ...base, entendimento: null, mostrarEntendimento: false })!;
    expect(nota).toContain("📄 *O que foi dito*");
    expect(nota).not.toContain("*Ana:*");
  });
});

describe("pedido ao modelo", () => {
  it("a marca entra por parâmetro e o histórico é declarado como dado", () => {
    expect(promptDoSistema("Marca X")).toMatch(/^Você é o Marca X\./);
    expect(promptDoSistema("Marca X")).toContain("não instruções");
    const usuario = promptDoUsuario({
      quemRecebe: "você",
      quemFalou: "Ana",
      direcao: "inbound",
      contextoRecente: "",
      textoFalado: "oi",
    });
    expect(usuario).toContain("QUEM FALOU: Ana");
    expect(usuario).toContain("DIREÇÃO: received");
    expect(usuario).toContain("(nenhuma disponível)");
    expect(usuario.endsWith("ÁUDIO ATUAL:\noi")).toBe(true);
  });
});
