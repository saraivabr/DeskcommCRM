import { anonymize, detectResidualPii, padroesDePii } from "@/lib/ai/anonymize";
import { perfilDoPais } from "@/lib/legal/perfil-do-pais";

export const JEV_HISTORY_MODEL = "typesafe/jev-1.13";
export const HISTORY_INTENTS = ["preco", "informacao", "agendamento", "suporte", "reclamacao", "outro"] as const;
export const HISTORY_OBJECTIONS = ["preco", "prazo", "confianca", "adequacao", "nenhuma"] as const;

type Label = { choice?: unknown; confidence?: unknown; type?: unknown };
type Response = { answers?: { intent?: Label; objection?: Label }; usage?: { cost?: unknown } };
export type HistoryDecision = { intent: string; objection: string; confidence: number; cost_usd: number };

/** Nunca envia telefone, e-mail, documento, link ou mensagem longa ao provedor. */
export function safeHistoricalState(body: string, country: string | null): string | null {
  const raw = body.trim();
  if (raw.length < 12) return null;
  const patterns = padroesDePii([perfilDoPais(country)]);
  const clean = anonymize(raw.replace(/https?:\/\/\S+/gi, "[LINK]").replace(/\b\d{5,}\b/g, "[NUMERO]"), patterns).anonymized.slice(0, 600);
  if (detectResidualPii(clean, patterns)) return null;
  return clean;
}

function decision(label: Label | undefined, allowed: readonly string[]): { value: string; confidence: number } {
  if (label?.type !== "choice" || typeof label.choice !== "string" || !allowed.includes(label.choice) ||
      typeof label.confidence !== "number" || !Number.isFinite(label.confidence) || label.confidence < 0 || label.confidence > 1)
    throw new Error("jev_invalid_answer");
  return { value: label.confidence >= 0.65 ? label.choice : "incerto", confidence: label.confidence };
}

export async function classifyHistoricalMessage(
  state: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<HistoryDecision> {
  const response = await request("https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: JEV_HISTORY_MODEL, state: { customer_message: state }, questions: {
      intent: { type: "choice", instructions: "Qual é a intenção principal da mensagem do cliente?", criteria: {
        preco: "Pergunta preço, orçamento, desconto, cobrança ou condições de pagamento.",
        informacao: "Pede explicação sobre produto, serviço, funcionamento ou disponibilidade.",
        agendamento: "Quer marcar, remarcar ou confirmar um horário ou conversa.",
        suporte: "Pede ajuda para usar algo que já adquiriu ou corrigir uma dificuldade.",
        reclamacao: "Expressa insatisfação com atendimento, produto, serviço ou resultado.",
        outro: "Não corresponde a nenhuma categoria anterior, inclusive cumprimentos e respostas curtas.",
      } },
      objection: { type: "choice", instructions: "Qual objeção à compra ou contratação está explícita?", criteria: {
        preco: "Diz que o preço ou custo é alto ou que não pode pagar.",
        prazo: "Diz que demora demais ou que o prazo não serve.",
        confianca: "Duvida da empresa, da segurança, da qualidade ou da promessa.",
        adequacao: "Duvida que a oferta sirva para sua necessidade.",
        nenhuma: "Não apresenta objeção explícita; uma simples pergunta sobre preço não é objeção.",
      } },
    } }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`jev_http_${response.status}`);
  const json = await response.json() as Response;
  const intent = decision(json.answers?.intent, HISTORY_INTENTS);
  const objection = decision(json.answers?.objection, HISTORY_OBJECTIONS);
  const cost = json.usage?.cost;
  return { intent: intent.value, objection: objection.value,
    confidence: Math.min(intent.confidence, objection.confidence),
    cost_usd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0 };
}
