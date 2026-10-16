/**
 * Adapter that exposes `ai-sentiment-worker` to the event_log dispatcher.
 *
 * Registers on `message.received` alongside `ai-response-worker.v1`. O dreno
 * roda os handlers EM SÉRIE (`lib/event-log/dispatcher.ts`), um evento por vez:
 * a chamada ao modelo daqui atrasa todo consumidor que vem depois no lote.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { processSentiment } from "@/workers/ai-sentiment-worker";

export const AI_SENTIMENT_HANDLER_KEY = "ai-sentiment-worker.v1";

export const aiSentimentHandler: EventHandler = {
  key: AI_SENTIMENT_HANDLER_KEY,
  events: ["message.received"],
  async handle(row): Promise<HandlerResult> {
    // Dreno DENTRO do webhook de mensagem (`acelerarPipelineDeEventos`): a
    // chamada ao modelo somaria ao tempo de resposta do webhook, que tem timeout
    // e reentrega — e roda ANTES de o despacho do agente ser emitido. `retry`
    // deixa a linha `pending` sem contar tentativa, com os outros handlers já
    // em `consumed_by`; `retry_at` = agora a devolve ao próximo dreno de fora
    // (o laço do worker, a cada poucos segundos), não daqui a 15s como os
    // avisos: o handoff por sentimento deve sair antes da janela de rajada do
    // agente fechar.
    if (origemDoDreno() === "request") {
      return {
        consumer_key: AI_SENTIMENT_HANDLER_KEY,
        status: "retry",
        retry_at: new Date().toISOString(),
        detail: "adiado: dreno dentro do webhook",
      };
    }
    const result = await processSentiment(row);
    if (!result.skipped) {
      return {
        consumer_key: AI_SENTIMENT_HANDLER_KEY,
        status: "ok",
        detail: String(result.sentiment_score ?? ""),
      };
    }
    return {
      consumer_key: AI_SENTIMENT_HANDLER_KEY,
      status: "skipped",
      detail: result.reason,
    };
  },
};
