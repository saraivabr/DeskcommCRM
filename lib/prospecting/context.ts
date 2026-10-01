import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { campaignConfigSchema } from "./schema";
import { PROSPECTING_REPLY_GUIDANCE } from "./conversation-guidance";

/** Trusted operator criteria; scraped websites never become system instructions. */
export async function prospectingConversationContext(
  db: Queryable,
  org: string,
  conversationId: string,
) {
  const { rows } = await db.query<{ config: unknown }>(
    "select c.config from prospecting_candidates p join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id where p.organization_id=$1 and p.conversation_id=$2 and p.status in ('sending','sent') limit 1",
    [org, conversationId],
  );
  const parsed = campaignConfigSchema.safeParse(rows[0]?.config);
  if (!parsed.success) return "";
  const c = parsed.data;
  return `\n\nEsta conversa veio de uma campanha de prospecção. Objetivo definido pelo operador: ${c.instruction}\nCritérios de qualificação a confirmar com a pessoa: ${c.qualification}\n${PROSPECTING_REPLY_GUIDANCE}\nUma empresa encontrada na pesquisa ainda não é um cliente qualificado. Registre apenas fatos confirmados. Só depois de confirmar os critérios, use as ferramentas disponíveis para mover o negócio do funil ${c.pipeline_id} para a etapa ${c.qualified_stage_id}. Explique a evidência no registro. Se faltar evidência, mantenha a etapa atual; não pressione a pessoa para completar critérios. Respeite intervenção humana e não prometa condições fora da política do agente.`;
}
