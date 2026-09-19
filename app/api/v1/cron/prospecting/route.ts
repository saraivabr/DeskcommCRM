import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { tickProspecting } from "@/lib/prospecting/worker";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function handle(req: Request) {
  const requestId = randomUUID();
  const value = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (!value || !accepted.includes(value))
    return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  try {
    const rodada = await tickProspecting(getRequestPool(), createAdminClient());
    // A rodada só ENTRA na trilha quando houve efeito: uma varredura que não
    // achou o que fazer não é mutação, e registrá-la deixaria a auditoria igual
    // à da rodada que trabalhou. `processed` é quantas organizações a rodada
    // tocou (lib/prospecting/worker.ts); rodada de cron sem efeito não audita.
    if (rodada.processed > 0)
      void audit({
        action: "prospecting.rodada_executada",
        bypassedRls: true,
        metadata: { processed: rodada.processed },
        requestId,
      });
    return ok(rodada, { requestId });
  } catch (err) {
    // O `catch` era SEM PARÂMETRO: o objeto do erro não ficava de fora do log,
    // ele era DESCARTADO — não existia em variável nenhuma. Num cron, que roda
    // sozinho e sem ninguém olhando, isso significava que a prospecção da
    // instalação inteira podia parar e a única evidência ser um 500 numa
    // resposta que ninguém lê.
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[prospecting.cron] tickProspecting lançou", { error: detalhe, requestId });
    // E o erro sai do processo. O log acima mora no arquivo de uma instalação
    // que pode estar quebrada justamente onde ele foi escrito, e quem chama um
    // cron não fica olhando a resposta: sem isso, a prospecção de um cliente
    // pode parar por dias e a descoberta depende de alguém reclamar. Mesmo
    // caminho do audit log (lib/audit/index.ts): import dinâmico para não pagar
    // o custo no caminho que dá certo, e `.catch` porque falhar ao REPORTAR não
    // pode substituir a causa da falha original.
    void import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          level: "error",
          tags: { subsystem: "prospecting", cron: "prospecting" },
          extra: { requestId, error_detail: detalhe },
        });
      })
      .catch(() => {
        /* sem Sentry configurado: o logger.error acima é o que resta */
      });
    // O detalhe vai na resposta, como o routing-worker faz: quem chama o cron à
    // mão para investigar merece ler a causa, não uma frase genérica.
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;
