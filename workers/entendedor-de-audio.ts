/**
 * Entendedor de áudio — consome `audio_understanding.requested`.
 *
 * Quem emite é o worker de derivação de mídia, quando o texto do áudio fica
 * pronto. Daqui em diante:
 *
 *   configuração da org → política → reserva da franquia (atômica, por
 *   mensagem) → contexto da conversa → modelo → nota → envio citando o áudio
 *   → liquidação (cobra só com envio aceito; falha devolve a franquia).
 *
 * ─── Por que nunca reenvia ──────────────────────────────────────────────────
 * O fluxo anterior tinha retry no envio e chegou a mandar a nota duas vezes.
 * Aqui a reserva é a chave: a segunda tentativa de um áudio já `charged` ou
 * `released` é pulada. Nota em dobro na conversa de alguém é pior que nota
 * nenhuma — o mesmo critério do cron `recover-stuck-messages`.
 *
 * ─── Sistema Vivo ───────────────────────────────────────────────────────────
 * Recusa por franquia ou por falta de modelo abre aviso na Central (um por vez
 * por organização). O consumo aparece em Entendedor de áudio, e a nota nasce
 * como linha em `messages`, então fica na timeline da conversa.
 */
import { generateObject } from "ai";

import { DEFAULT_CLASSIFIER_MODEL } from "@/lib/ai/gateway";
import { resolverModeloDoPonto } from "@/lib/ai/gateway-binding";
import { runMeteredOperation, measuredGeneration } from "@/lib/billing/metered-operation";
import { marcaDaSaida } from "@/lib/branding/saida";
import { comporNota } from "@/lib/entendedor/composicao";
import {
  inicioDoPeriodo,
  inicioDoProximoPeriodo,
  limiteDaOrganizacao,
  segundosCobraveis,
} from "@/lib/entendedor/franquia";
import { CONFIGURACAO_PADRAO, decidirSeEntende, type ConfiguracaoDoEntendedor } from "@/lib/entendedor/politica";
import { entendimentoSchema, promptDoSistema, promptDoUsuario, type Entendimento } from "@/lib/entendedor/prompt";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { MARCADOR_NAO_LIDA } from "@/workers/media-derive-worker";

export const ENTENDEDOR_CONSUMER_KEY = "entendedor_de_audio_v1";
export const EVENTO_ENTENDEDOR = "audio_understanding.requested";
/** Ponto de IA no painel de Provedores — ver `lib/ai/pontos/registro.ts`. */
export const PONTO_DO_ENTENDEDOR = "entendimento_de_audio";
/** Marca a nota em `messages.metadata.origem` — o contexto da conversa a ignora. */
export const ORIGEM_DA_NOTA = "entendedor_de_audio";


const TIMEOUT_DO_MODELO_MS = 25_000;
const CONTEXTO_JANELA_MS = 72 * 60 * 60 * 1000;
const CONTEXTO_MAX_MENSAGENS = 8;
const CONTEXTO_MAX_CARACTERES = 260;

type Admin = ReturnType<typeof createAdminClient>;

interface AudioRow {
  id: string;
  organization_id: string;
  conversation_id: string;
  channel_session_id: string | null;
  type: string;
  direction: "inbound" | "outbound";
  external_id: string | null;
  media_derived_text: string | null;
  media_derived_status: string | null;
  metadata: Record<string, unknown> | null;
}

interface ConversaRow {
  id: string;
  is_group: boolean;
  group_chat_id: string | null;
  contact_id: string | null;
  contacts: {
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    wa_identity: string | null;
    wa_lid: string | null;
  } | null;
}

/** Dependências trocáveis em teste. O padrão é o caminho de produção. */
export interface DepsDoEntendedor {
  admin: Admin;
  entender(input: {
    organizationId: string;
    sistema: string;
    usuario: string;
  }): Promise<Entendimento | "sem_modelo">;
  enviar(input: {
    organizationId: string;
    canalId: string;
    conversa: ConversaRow;
    texto: string;
    citarExternalId: string | null;
  }): Promise<{ externalId: string | null }>;
  marca(organizationId: string): Promise<string>;
  agora(): Date;
}

export async function entenderAudio(
  row: EventRow,
  deps: DepsDoEntendedor = depsDeProducao(),
): Promise<HandlerResult> {
  const consumer_key = ENTENDEDOR_CONSUMER_KEY;
  const orgId = row.organization_id;
  const messageId = (row.payload.message_id as string | undefined) ?? row.entity_id;
  if (!messageId) return { consumer_key, status: "skipped", detail: "sem message_id" };
  const { admin } = deps;

  const config = await lerConfiguracao(admin, orgId);
  if (!config.enabled) return { consumer_key, status: "skipped", detail: "desligado" };

  // ⚠️ `organization_id` filtrado à mão: service role ignora RLS, e a org vem
  // da linha do event_log, nunca do payload.
  const { data: audioData, error: audioErr } = await admin
    .from("messages")
    .select(
      "id, organization_id, conversation_id, channel_session_id, type, direction, external_id, media_derived_text, media_derived_status, metadata",
    )
    .eq("id", messageId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (audioErr) return { consumer_key, status: "error", detail: audioErr.message };
  const audio = audioData as AudioRow | null;
  if (!audio || audio.type !== "audio") return { consumer_key, status: "skipped", detail: "não é áudio" };
  if (audio.media_derived_status !== "ready") {
    return { consumer_key, status: "skipped", detail: `texto do áudio ${audio.media_derived_status ?? "ausente"}` };
  }
  const textoFalado = (audio.media_derived_text ?? "").trim();
  if (!textoFalado || textoFalado === MARCADOR_NAO_LIDA) {
    return { consumer_key, status: "skipped", detail: "áudio sem fala reconhecida" };
  }
  if (!audio.channel_session_id) return { consumer_key, status: "skipped", detail: "sem canal" };

  const { data: convData, error: convErr } = await admin
    .from("conversations")
    .select("id, is_group, group_chat_id, contact_id, contacts:contact_id(name, display_name, phone_number, wa_identity, wa_lid)")
    .eq("id", audio.conversation_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (convErr) return { consumer_key, status: "error", detail: convErr.message };
  const conversa = convData as unknown as ConversaRow | null;
  if (!conversa) return { consumer_key, status: "skipped", detail: "conversa não encontrada" };

  const decisao = decidirSeEntende(config, { direction: audio.direction, isGroup: conversa.is_group });
  if (!decisao.processa) return { consumer_key, status: "skipped", detail: decisao.motivo };

  const segundos = segundosCobraveis(Number(audio.metadata?.audio_seconds));
  if (segundos === null) {
    logger.warn("[entendedor] áudio sem duração declarada pelo canal", { organization_id: orgId, message_id: audio.id });
    return { consumer_key, status: "skipped", detail: "sem duração" };
  }

  // ─── Reserva ────────────────────────────────────────────────────────────
  const agora = deps.agora();
  const periodo = inicioDoPeriodo(agora);
  const limite = limiteDaOrganizacao(config.monthly_limit_seconds);
  const { data: reservaData, error: reservaErr } = await admin.rpc("fn_entendedor_reservar" as never, {
    p_organization_id: orgId,
    p_message_id: audio.id,
    p_seconds: segundos,
    p_limit_seconds: limite,
    p_period_start: periodo,
  } as never);
  if (reservaErr) return { consumer_key, status: "error", detail: reservaErr.message };
  const reserva = (Array.isArray(reservaData) ? reservaData[0] : reservaData) as
    | { admitido: boolean; motivo: string; usados: number; limite: number }
    | undefined;
  if (!reserva) return { consumer_key, status: "error", detail: "reserva sem resposta" };
  if (!reserva.admitido) {
    if (reserva.motivo === "franquia_esgotada") {
      await avisar(admin, orgId, "budget_exceeded", {
        title: "Os minutos grátis do Entendedor de áudio acabaram este mês",
        body:
          `A organização usou ${Math.floor(reserva.usados / 60)} de ${Math.floor(limite / 60)} minutos. ` +
          `Os áudios seguintes não recebem a nota até ${formatarData(inicioDoProximoPeriodo(agora))}, quando a franquia renova. ` +
          "O áudio continua na conversa normalmente.",
      });
    }
    return { consumer_key, status: "skipped", detail: reserva.motivo };
  }

  const liberar = async (motivo: string) => {
    const { error } = await admin.rpc("fn_entendedor_liquidar" as never, {
      p_organization_id: orgId,
      p_message_id: audio.id,
      p_status: "released",
      p_reply_message_id: null,
      p_failure_reason: motivo,
    } as never);
    if (error) logger.error("[entendedor] não consegui devolver a franquia", { organization_id: orgId, message_id: audio.id, error: error.message });
  };

  // ─── Entendimento ───────────────────────────────────────────────────────
  const marca = await deps.marca(orgId);
  const nomeDoContato = primeiroNome(conversa.contacts?.display_name || conversa.contacts?.name);
  const quemFalou = audio.direction === "outbound" ? "Você" : nomeDoContato || "Contato";

  let entendimento: Entendimento | null = null;
  if (config.show_understanding) {
    try {
      const contexto = await contextoRecente(admin, orgId, audio, nomeDoContato, agora);
      const r = await deps.entender({
        organizationId: orgId,
        sistema: promptDoSistema(marca),
        usuario: promptDoUsuario({
          quemRecebe: "você",
          quemFalou,
          direcao: audio.direction,
          contextoRecente: contexto,
          textoFalado,
        }),
      });
      if (r === "sem_modelo") {
        await liberar("sem_modelo");
        await avisar(admin, orgId, "midia_nao_lida", {
          title: "O Entendedor de áudio está sem modelo de IA",
          body: "Nenhum modelo respondeu pelo ponto 'Entender o áudio'. Escolha um modelo ou cadastre uma chave em Agente de IA → Provedores.",
        });
        return { consumer_key, status: "skipped", detail: "sem modelo" };
      }
      entendimento = r;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Sem entendimento, a nota ainda pode sair só com o texto falado — se
      // essa parte estiver ligada. Senão, devolve a franquia e para aqui.
      if (!config.show_spoken_text) {
        await liberar("modelo_falhou");
        return { consumer_key, status: "error", detail };
      }
      logger.warn("[entendedor] modelo falhou; seguindo só com o texto falado", { organization_id: orgId, message_id: audio.id, detail });
    }
  }

  const texto = comporNota({
    segundos,
    quemFalou,
    entendimento,
    textoFalado,
    mostrarEntendimento: config.show_understanding,
    mostrarTextoFalado: config.show_spoken_text,
    marca,
  });
  if (!texto) {
    await liberar("sem_conteudo");
    return { consumer_key, status: "skipped", detail: "nada para mandar" };
  }

  // ─── Envio ──────────────────────────────────────────────────────────────
  // A linha nasce ANTES do envio, sem external_id: é o que a ingestão usa para
  // reconhecer o eco como envio nosso (e não pausar a IA da conversa).
  const { data: notaData, error: notaErr } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: audio.conversation_id,
      channel_session_id: audio.channel_session_id,
      contact_id: conversa.contact_id,
      type: "text",
      direction: "outbound",
      status: "sending",
      body: texto,
      sent_via: "system",
      reply_to_message_id: audio.id,
      metadata: { origem: ORIGEM_DA_NOTA, audio_message_id: audio.id },
    })
    .select("id")
    .maybeSingle();
  if (notaErr || !notaData) {
    await liberar("nota_nao_gravada");
    return { consumer_key, status: "error", detail: notaErr?.message ?? "nota não gravada" };
  }
  const notaId = (notaData as { id: string }).id;

  let externalId: string | null = null;
  try {
    const r = await deps.enviar({
      organizationId: orgId,
      canalId: audio.channel_session_id,
      conversa,
      texto,
      citarExternalId: audio.external_id,
    });
    externalId = r.externalId;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await admin.from("messages").update({ status: "failed" }).eq("id", notaId).eq("organization_id", orgId);
    await liberar("envio_falhou");
    // `ok`, não `error`: o dreno repetiria, e a reserva já liberada faria a
    // repetição ser pulada de qualquer jeito. O registro fica na nota `failed`.
    return { consumer_key, status: "ok", detail: `envio falhou: ${detail.slice(0, 160)}` };
  }

  if (!externalId) {
    // Sem id o canal não confirmou o envio. Não cobra; a nota fica `failed`
    // para quem olha a conversa saber que pode não ter saído.
    await admin.from("messages").update({ status: "failed" }).eq("id", notaId).eq("organization_id", orgId);
    await liberar("envio_sem_confirmacao");
    return { consumer_key, status: "ok", detail: "envio sem confirmação do canal" };
  }

  await admin
    .from("messages")
    .update({ status: "sent", external_id: externalId, sent_at: agora.toISOString() })
    .eq("id", notaId)
    .eq("organization_id", orgId);

  const { error: liquidarErr } = await admin.rpc("fn_entendedor_liquidar" as never, {
    p_organization_id: orgId,
    p_message_id: audio.id,
    p_status: "charged",
    p_reply_message_id: notaId,
    p_failure_reason: null,
  } as never);
  if (liquidarErr) {
    logger.error("[entendedor] nota enviada mas a cobrança não foi registrada", { organization_id: orgId, message_id: audio.id, error: liquidarErr.message });
  }

  // O entendimento também fica no próprio áudio — a tela da conversa já lê
  // estas colunas (`components/inbox/media/MediaRenderer.tsx`).
  if (entendimento) {
    await admin
      .from("messages")
      .update({ audio_summary: entendimento.key_sentence.slice(0, 1000), audio_intent: entendimento.intent })
      .eq("id", audio.id)
      .eq("organization_id", orgId);
  }

  return { consumer_key, status: "ok" };
}

export async function lerConfiguracao(admin: Admin, orgId: string): Promise<ConfiguracaoDoEntendedor> {
  const { data, error } = await admin
    .from("audio_understanding_settings" as never)
    .select("enabled, process_received, process_sent, groups_enabled, show_understanding, show_spoken_text, monthly_limit_seconds")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) {
    // Falha fechada: sem conseguir ler, não processa (e não cobra).
    logger.warn("[entendedor] não consegui ler a configuração", { organization_id: orgId, error: error.message });
    return CONFIGURACAO_PADRAO;
  }
  return { ...CONFIGURACAO_PADRAO, ...((data as Partial<ConfiguracaoDoEntendedor> | null) ?? {}) };
}

function primeiroNome(nome: string | null | undefined): string {
  const limpo = String(nome ?? "").split("|")[0]!.trim();
  if (!limpo || /^\+?\d[\d\s-]{8,}$/.test(limpo) || /@/.test(limpo)) return "";
  return limpo.split(/\s+/)[0]!.slice(0, 40);
}

/**
 * As últimas mensagens de TEXTO da mesma conversa, das últimas 72 h — do
 * próprio CRM, sem perguntar nada ao canal. As notas do entendedor ficam de
 * fora, para o modelo não resumir o próprio resumo.
 */
async function contextoRecente(
  admin: Admin,
  orgId: string,
  audio: AudioRow,
  nomeDoContato: string,
  agora: Date,
): Promise<string> {
  const desde = new Date(agora.getTime() - CONTEXTO_JANELA_MS).toISOString();
  const { data } = await admin
    .from("messages")
    .select("id, direction, body, metadata, created_at")
    .eq("organization_id", orgId)
    .eq("conversation_id", audio.conversation_id)
    .eq("type", "text")
    .gte("created_at", desde)
    .neq("id", audio.id)
    .order("created_at", { ascending: false })
    .limit(CONTEXTO_MAX_MENSAGENS * 2);
  const linhas = ((data ?? []) as Array<{ direction: string; body: string | null; metadata: Record<string, unknown> | null }>)
    .filter((m) => m.metadata?.origem !== ORIGEM_DA_NOTA && (m.body ?? "").trim())
    .slice(0, CONTEXTO_MAX_MENSAGENS)
    .reverse()
    .map((m) => {
      const quem = m.direction === "outbound" ? "VOCÊ" : (nomeDoContato || "CONTATO").toUpperCase();
      return `${quem}: ${(m.body ?? "").replace(/\s+/g, " ").trim().slice(0, CONTEXTO_MAX_CARACTERES)}`;
    });
  return linhas.join("\n");
}

function formatarData(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

/** Um aviso aberto por tipo e organização — o padrão do worker de mídia. */
async function avisar(
  admin: Admin,
  orgId: string,
  kind: "budget_exceeded" | "midia_nao_lida",
  texto: { title: string; body: string },
): Promise<void> {
  try {
    const { data: aberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", orgId)
      .eq("kind", kind)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (aberto) return;
    const { error } = await admin.from("agent_inbox_items").insert({ organization_id: orgId, kind, severity: "warn", ...texto });
    if (error) logger.warn("[entendedor] o banco recusou o aviso", { organization_id: orgId, kind, error: error.message });
  } catch (err) {
    logger.warn("[entendedor] não consegui abrir o aviso", { organization_id: orgId, kind, error: err instanceof Error ? err.message : String(err) });
  }
}

function depsDeProducao(): DepsDoEntendedor {
  return {
    admin: createAdminClient(),
    agora: () => new Date(),
    marca: async (orgId) => (await marcaDaSaida(orgId)).nome,
    async entender({ organizationId, sistema, usuario }) {
      const resolvido = await resolverModeloDoPonto(PONTO_DO_ENTENDEDOR, organizationId, DEFAULT_CLASSIFIER_MODEL);
      if (!resolvido) return "sem_modelo";
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_DO_MODELO_MS);
      try {
        const r = await runMeteredOperation(
          { organizationId, provider: resolvido.provider, model: resolvido.modelId },
          () =>
            generateObject({
              model: resolvido.model,
              schema: entendimentoSchema,
              system: sistema,
              prompt: usuario,
              temperature: 0.15,
              maxOutputTokens: 1050,
              abortSignal: abort.signal,
            }),
          (response) => measuredGeneration(response),
        );
        return r.object;
      } finally {
        clearTimeout(timer);
      }
    },
    async enviar({ organizationId, canalId, conversa, texto, citarExternalId }) {
      // Import tardio: o mesmo motivo de `criarTransporteDoAviso` — quem só
      // registra o handler não arrasta os adapters de todos os canais.
      const { getAdapter, resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS } = await import("@/lib/channels");
      const admin = createAdminClient();
      const { data } = await admin
        .from("channel_sessions")
        .select(CHANNEL_SESSION_REF_COLUMNS)
        .eq("organization_id", organizationId)
        .eq("id", canalId)
        .maybeSingle();
      const ref = data as Parameters<typeof resolveSessionRef>[0] | null;
      if (!ref) throw new Error("canal_nao_encontrado");
      const adapter = getAdapter(ref.provider as never);
      if (!adapter.isConfigured()) throw new Error("canal_nao_configurado");
      const to = adapter.resolveRecipient({
        isGroup: conversa.is_group,
        groupChatId: conversa.group_chat_id,
        phoneNumber: conversa.contacts?.phone_number,
        waIdentity: conversa.contacts?.wa_identity,
        waLid: conversa.contacts?.wa_lid,
      });
      if (!to) throw new Error("destinatario_sem_endereco");
      return adapter.send({
        organizationId,
        sessionRef: resolveSessionRef(ref),
        to,
        kind: "text",
        body: texto,
        replyToExternalId: citarExternalId,
      });
    },
  };
}
