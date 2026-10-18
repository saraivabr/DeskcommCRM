/**
 * O worker do entendedor de ponta a ponta, com um banco em memória que imita o
 * pedaço do PostgREST que ele usa e uma reserva que segue o contrato de
 * `fn_entendedor_reservar` (a prova SQL da função mora nos invariantes).
 *
 * O que se prova aqui é o laço: só cobra com envio aceito, falha devolve a
 * franquia, reprocessar não manda a nota de novo, e franquia esgotada avisa.
 */
import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { Entendimento } from "@/lib/entendedor/prompt";
import { entenderAudio, ORIGEM_DA_NOTA, type DepsDoEntendedor } from "@/workers/entendedor-de-audio";

type Linha = Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-000000000001";
const OUTRA_ORG = "00000000-0000-4000-8000-000000000002";
const AUDIO = "00000000-0000-4000-8000-0000000000a1";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const CANAL = "00000000-0000-4000-8000-0000000000d1";

function bancoFalso(tabelas: Record<string, Linha[]>) {
  let seq = 0;
  const rpcs: Array<{ fn: string; args: Linha }> = [];

  function consulta(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let ordem: { col: string; asc: boolean } | null = null;
    let acao: { tipo: "select" } | { tipo: "update"; valores: Linha } | { tipo: "insert"; linha: Linha } = { tipo: "select" };
    const linhas = () => (tabelas[tabela] ??= []);
    const filtradas = () => {
      let r = linhas().filter((l) => filtros.every((f) => f(l)));
      if (ordem) {
        const { col, asc } = ordem;
        r = [...r].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return r.slice(0, limite);
    };
    const executar = () => {
      if (acao.tipo === "insert") {
        // Default do banco: aviso nasce `open` (coluna `agent_inbox_items.status`).
        const nova = { id: `id-${++seq}`, created_at: new Date().toISOString(), ...(tabela === "agent_inbox_items" ? { status: "open" } : {}), ...acao.linha };
        linhas().push(nova);
        return { data: nova, error: null };
      }
      if (acao.tipo === "update") {
        const alvo = filtradas();
        for (const l of alvo) Object.assign(l, (acao as { valores: Linha }).valores);
        return { data: alvo, error: null };
      }
      return { data: filtradas(), error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      gte: (c: string, v: unknown) => (filtros.push((l) => String(l[c]) >= String(v)), q),
      order: (col: string, o?: { ascending?: boolean }) => ((ordem = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limite = n), q),
      insert: (linha: Linha) => ((acao = { tipo: "insert", linha }), q),
      update: (valores: Linha) => ((acao = { tipo: "update", valores }), q),
      maybeSingle: async () => {
        const r = executar();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
      },
      then: (ok: (v: unknown) => unknown) => Promise.resolve(executar()).then(ok),
    };
    return q;
  }

  function rpc(fn: string, args: Linha) {
    rpcs.push({ fn, args });
    const usos = (tabelas.audio_understanding_usage ??= []);
    if (fn === "fn_entendedor_reservar") {
      const existente = usos.find((u) => u.organization_id === args.p_organization_id && u.message_id === args.p_message_id);
      const usados = usos
        .filter((u) => u.organization_id === args.p_organization_id && u.period_start === args.p_period_start && u.status !== "released")
        .reduce((s, u) => s + (u.seconds as number), 0);
      if (existente) {
        const st = existente.status as string;
        const motivo = { reserved: "ja_reservado", charged: "ja_cobrado", released: "ja_liberado" }[st];
        return Promise.resolve({
          data: [{ admitido: st === "reserved", motivo, usados, limite: args.p_limit_seconds }],
          error: null,
        });
      }
      if (usados + (args.p_seconds as number) > (args.p_limit_seconds as number)) {
        return Promise.resolve({ data: [{ admitido: false, motivo: "franquia_esgotada", usados, limite: args.p_limit_seconds }], error: null });
      }
      usos.push({
        organization_id: args.p_organization_id,
        message_id: args.p_message_id,
        period_start: args.p_period_start,
        seconds: args.p_seconds,
        status: "reserved",
      });
      return Promise.resolve({ data: [{ admitido: true, motivo: "reservado", usados: usados + (args.p_seconds as number), limite: args.p_limit_seconds }], error: null });
    }
    if (fn === "fn_entendedor_liquidar") {
      const u = usos.find((x) => x.organization_id === args.p_organization_id && x.message_id === args.p_message_id && x.status === "reserved");
      if (u) Object.assign(u, { status: args.p_status, reply_message_id: args.p_reply_message_id, failure_reason: args.p_failure_reason });
      return Promise.resolve({ data: Boolean(u), error: null });
    }
    return Promise.resolve({ data: null, error: { message: `rpc ${fn} desconhecida` } });
  }

  return { admin: { from: consulta, rpc } as unknown as DepsDoEntendedor["admin"], tabelas, rpcs };
}

function cenario(opcoes: { settings?: Linha | null; audio?: Partial<Linha>; usos?: Linha[] } = {}) {
  const tabelas: Record<string, Linha[]> = {
    audio_understanding_settings:
      opcoes.settings === null
        ? []
        : [{ organization_id: ORG, enabled: true, ...(opcoes.settings ?? {}) }],
    messages: [
      {
        id: AUDIO,
        organization_id: ORG,
        conversation_id: CONV,
        channel_session_id: CANAL,
        type: "audio",
        direction: "inbound",
        external_id: "wamid-audio",
        media_derived_text: "Oi, você topa aquele valor que a gente falou?",
        media_derived_status: "ready",
        metadata: { raw_type: "ptt", audio_seconds: 19 },
        created_at: "2026-10-17T12:00:00Z",
        ...(opcoes.audio ?? {}),
      },
      {
        id: "msg-texto",
        organization_id: ORG,
        conversation_id: CONV,
        type: "text",
        direction: "outbound",
        body: "Te mando o orçamento amanhã",
        metadata: {},
        created_at: "2026-10-17T11:00:00Z",
      },
    ],
    conversations: [
      {
        id: CONV,
        organization_id: ORG,
        is_group: false,
        group_chat_id: null,
        contact_id: "contato-1",
        contacts: { name: "Ana Souza", display_name: null, phone_number: "+5511999990000", wa_identity: null, wa_lid: null },
      },
    ],
    audio_understanding_usage: opcoes.usos ?? [],
    agent_inbox_items: [],
  };
  return bancoFalso(tabelas);
}

const ENTENDIMENTO: Entendimento = {
  category: "short",
  intent: "pedir",
  focus: "valor",
  key_sentence: "Pergunta se o valor combinado está de pé.",
  message: "Quer saber se você topa o valor que conversaram.",
  points: [],
  decisions: [],
  next_steps: [],
  requests: [],
};

function deps(banco: ReturnType<typeof bancoFalso>, sobre: Partial<DepsDoEntendedor> = {}) {
  const enviados: Array<{ texto: string; citarExternalId: string | null }> = [];
  const pedidos: Array<{ usuario: string }> = [];
  const d: DepsDoEntendedor = {
    admin: banco.admin,
    agora: () => new Date("2026-10-17T15:00:00Z"),
    marca: async () => "Marca de Teste",
    entender: async (p) => (pedidos.push({ usuario: p.usuario }), ENTENDIMENTO),
    enviar: async (p) => (enviados.push({ texto: p.texto, citarExternalId: p.citarExternalId }), { externalId: "wamid-nota" }),
    ...sobre,
  };
  return { d, enviados, pedidos };
}

const evento = (org = ORG): EventRow => ({
  id: "evt-1",
  organization_id: org,
  event_type: "audio_understanding.requested",
  entity_kind: "message",
  entity_id: AUDIO,
  payload: { message_id: AUDIO },
  metadata: {},
  consumed_by: [],
  attempts: 0,
});

describe("entendedor de áudio — worker", () => {
  it("entende, responde citando o áudio e cobra só depois do envio aceito", async () => {
    const banco = cenario();
    const { d, enviados, pedidos } = deps(banco);

    const r = await entenderAudio(evento(), d);

    expect(r.status).toBe("ok");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.citarExternalId).toBe("wamid-audio");
    expect(enviados[0]!.texto).toContain("🎯 *Ana:* Quer saber se você topa o valor que conversaram.");
    expect(enviados[0]!.texto).toContain("economizei 19 segundos");
    // Contexto da conversa vem do CRM, sem perguntar ao canal.
    expect(pedidos[0]!.usuario).toContain("VOCÊ: Te mando o orçamento amanhã");

    const nota = banco.tabelas.messages!.find((m) => (m.metadata as Linha)?.origem === ORIGEM_DA_NOTA)!;
    expect(nota).toMatchObject({ status: "sent", external_id: "wamid-nota", sent_via: "system", reply_to_message_id: AUDIO });
    expect(banco.tabelas.audio_understanding_usage![0]).toMatchObject({ status: "charged", seconds: 19, period_start: "2026-10-01" });
    expect(banco.tabelas.messages!.find((m) => m.id === AUDIO)).toMatchObject({ audio_intent: "pedir" });
  });

  it("reprocessar o mesmo áudio não manda a nota de novo", async () => {
    const banco = cenario();
    const { d, enviados } = deps(banco);
    await entenderAudio(evento(), d);
    const segunda = await entenderAudio(evento(), d);
    expect(segunda).toMatchObject({ status: "skipped", detail: "ja_cobrado" });
    expect(enviados).toHaveLength(1);
  });

  it("organização sem configuração (desligada) não reserva nem envia", async () => {
    const banco = cenario({ settings: null });
    const { d, enviados } = deps(banco);
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "skipped", detail: "desligado" });
    expect(enviados).toHaveLength(0);
    expect(banco.rpcs).toHaveLength(0);
  });

  it("evento de outra organização não alcança a mensagem desta", async () => {
    const banco = cenario();
    banco.tabelas.audio_understanding_settings!.push({ organization_id: OUTRA_ORG, enabled: true });
    const { d, enviados } = deps(banco);
    expect(await entenderAudio(evento(OUTRA_ORG), d)).toMatchObject({ status: "skipped" });
    expect(enviados).toHaveLength(0);
  });

  it("franquia esgotada: não envia, não cobra e abre UM aviso na Central", async () => {
    const banco = cenario({
      usos: [{ organization_id: ORG, message_id: "antigo", period_start: "2026-10-01", seconds: 1790, status: "charged" }],
    });
    const { d, enviados } = deps(banco);
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "skipped", detail: "franquia_esgotada" });
    expect(enviados).toHaveLength(0);
    expect(banco.tabelas.agent_inbox_items).toHaveLength(1);
    expect(banco.tabelas.agent_inbox_items![0]).toMatchObject({ kind: "budget_exceeded", severity: "warn" });
    expect(String(banco.tabelas.agent_inbox_items![0]!.body)).toContain("01/11/2026");

    await entenderAudio({ ...evento(), id: "evt-2" }, d);
    expect(banco.tabelas.agent_inbox_items).toHaveLength(1);
  });

  it("envio que falha devolve a franquia e não repete", async () => {
    const banco = cenario();
    const { d } = deps(banco, {
      enviar: async () => {
        throw new Error("canal fora do ar");
      },
    });
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "ok" });
    expect(banco.tabelas.audio_understanding_usage![0]).toMatchObject({ status: "released", failure_reason: "envio_falhou" });
    const nota = banco.tabelas.messages!.find((m) => (m.metadata as Linha)?.origem === ORIGEM_DA_NOTA)!;
    expect(nota.status).toBe("failed");
  });

  it("envio sem confirmação do canal não é cobrado", async () => {
    const banco = cenario();
    const { d } = deps(banco, { enviar: async () => ({ externalId: null }) });
    await entenderAudio(evento(), d);
    expect(banco.tabelas.audio_understanding_usage![0]).toMatchObject({ status: "released", failure_reason: "envio_sem_confirmacao" });
  });

  it("modelo fora do ar: segue com o que foi dito, se essa parte estiver ligada", async () => {
    const banco = cenario();
    const { d, enviados } = deps(banco, {
      entender: async () => {
        throw new Error("timeout");
      },
    });
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "ok" });
    expect(enviados[0]!.texto).toContain("📄 *O que foi dito*");
    expect(enviados[0]!.texto).not.toContain("*Ana:*");
  });

  it("sem modelo configurado: devolve a franquia e avisa na Central", async () => {
    const banco = cenario();
    const { d, enviados } = deps(banco, { entender: async () => "sem_modelo" as const });
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "skipped", detail: "sem modelo" });
    expect(enviados).toHaveLength(0);
    expect(banco.tabelas.audio_understanding_usage![0]).toMatchObject({ status: "released" });
    expect(banco.tabelas.agent_inbox_items![0]).toMatchObject({ kind: "midia_nao_lida" });
  });

  it("áudio sem duração declarada não é processado (não há como cobrar)", async () => {
    const banco = cenario({ audio: { metadata: { raw_type: "ptt" } } });
    const { d, enviados } = deps(banco);
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "skipped", detail: "sem duração" });
    expect(enviados).toHaveLength(0);
  });

  it("áudio que a leitura não entendeu não vira nota", async () => {
    const banco = cenario({ audio: { media_derived_text: "[o cliente enviou uma mídia que não consegui interpretar]" } });
    const { d, enviados } = deps(banco);
    expect(await entenderAudio(evento(), d)).toMatchObject({ status: "skipped" });
    expect(enviados).toHaveLength(0);
  });

  it("áudio enviado só entra com a opção ligada, e quem falou vira 'Você'", async () => {
    const desligado = cenario({ audio: { direction: "outbound" } });
    expect(await entenderAudio(evento(), deps(desligado).d)).toMatchObject({ detail: "direcao_desligada" });

    const ligado = cenario({ audio: { direction: "outbound" }, settings: { process_sent: true } });
    const { d, enviados } = deps(ligado);
    await entenderAudio(evento(), d);
    expect(enviados[0]!.texto).toContain("*Você:*");
  });
});
