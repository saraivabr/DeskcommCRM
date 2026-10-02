/**
 * "ESTA ORG TEM ATENDIMENTO AUTOMÁTICO DE PÉ?" — uma pergunta, um lugar.
 *
 * O fato é ORG-WIDE, e é o único pedaço de `comandoDaConversa` que o banco não
 * pode responder sozinho: para saber se há agente no ar ele teria de reproduzir
 * `agenteAtende` inteiro dentro do SQL — a regra em mais uma encarnação, agora a
 * terceira. Então quem resolve é o servidor, e o resultado entra na consulta
 * escolhendo o CONJUNTO de comandos que a aba pede (`comandosDaFila`).
 *
 * Já havia dois consumidores no primeiro dia (`/api/v1/conversations/counts` e
 * `lib/routing/queue.ts`), e é por isso que isto nasce como função e não como
 * três linhas coladas em cada rota.
 *
 * **Devolve `undefined` quando não deu para saber**, nunca `false`: dizer "esta
 * org não tem automático" por causa de um erro de leitura faria a Fila incluir
 * tudo que o robô atende — a mentira original, ao contrário. `comandosDaFila`
 * trata `undefined` como "assume que há", a mesma convenção da regra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { agenteAtende } from "@/lib/ai/agents/no-ar";
import { ehVendedorPadraoDaProspeccao } from "@/lib/ai/agents/agente-da-conversa";

export async function orgTemAutomatico(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean | undefined> {
  // Same operational facts as `/api/v1/ai/automatico-ativo`, plus the marker
  // that excludes the campaign-only seller from general inbox availability.
  const { data, error } = await supabase
    .from("ai_agents")
    .select("kind, is_active, paused_at, published_version_id, archived_at, config")
    .eq("organization_id", organizationId)
    .is("archived_at", null);

  if (error) return undefined;
  return (data ?? []).some((a) => !ehVendedorPadraoDaProspeccao(a.config) && agenteAtende(a));
}
