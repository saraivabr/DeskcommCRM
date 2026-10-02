import type pg from "pg";

/** Only the exact conversation created by prospecting can choose its seller. */
export async function agenteDaProspeccaoDaConversa(
  db: pg.Pool,
  organizationId: string,
  conversationId: string,
  channelSessionId: string,
): Promise<{ agentId: string; pipelineId: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = db.query<{ agent_id: string | null; pipeline_id: string | null }>(
      `select c.config->>'agent_id' as agent_id,c.config->>'pipeline_id' as pipeline_id
       from prospecting_candidates p
       join prospecting_campaigns c on c.organization_id=p.organization_id and c.id=p.campaign_id
       where p.organization_id=$1 and p.conversation_id=$2
         and p.status in ('sending','sent')
         and c.config->>'channel_session_id'=$3
         and c.config->>'agent_id' is not null
         and c.config->>'pipeline_id' is not null
       order by p.attempted_at desc nulls last,p.id desc limit 1`,
      [organizationId, conversationId, channelSessionId],
    );
    const result = await Promise.race([
      lookup,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 500);
      }),
    ]);
    const row = result?.rows[0];
    return row?.agent_id && row.pipeline_id
      ? { agentId: row.agent_id, pipelineId: row.pipeline_id }
      : null;
  } catch {
    // Same fallback as campaign routing: an unavailable lookup does not take
    // over the channel or suppress its regular attendant.
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
