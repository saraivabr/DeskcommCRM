import { anonymize, detectResidualPii } from "@/lib/ai/anonymize";

export interface HistoricalLine { direction: string; body: string }

/** Indicadores descritivos; uma pergunta de cliente nunca vira regra do agente. */
export function summarizeWhatsappHistory(lines: HistoricalLine[]) {
  const inbound = lines.filter((line) => line.direction === "inbound");
  const outbound = lines.length - inbound.length;
  const counts = new Map<string, number>();
  for (const line of inbound) {
    const body = line.body.trim().replace(/\s+/g, " ");
    if (body.length < 12 || body.length > 220 || !body.includes("?")) continue;
    const safe = anonymize(body).anonymized;
    if (detectResidualPii(safe)) continue;
    const normalized = safe.toLocaleLowerCase("pt-BR").replace(/[!?.,]+$/g, "");
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const questions = [...counts].filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([question, count]) => ({ question, count }));
  return { inbound: inbound.length, outbound, questions };
}
