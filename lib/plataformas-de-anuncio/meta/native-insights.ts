import { z } from "zod";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import type { MetaGraphClient } from "@/lib/channels/meta/social/graph";
import type { CampanhaCrua, LinhaDeInsightCrua } from "./insights";

const metric = z.object({
  indicator: z.string().optional(),
  values: z.array(z.object({ value: z.string().optional() })).optional(),
});
const action = z.object({ action_type: z.string().optional(), value: z.string().optional() });
const campaign = z.object({
  id: z.string().regex(/^\d+$/),
  name: z.string().optional(),
  status: z.string().optional(),
  effective_status: z.string().optional(),
  objective: z.string().optional(),
});
const insight = z.object({
  campaign_id: z.string().regex(/^\d+$/).optional(),
  campaign_name: z.string().optional(),
  spend: z.string().optional(),
  impressions: z.string().optional(),
  reach: z.string().optional(),
  cpm: z.string().optional(),
  ctr: z.string().optional(),
  frequency: z.string().optional(),
  cpc: z.string().optional(),
  results: z.array(metric).optional(),
  cost_per_result: z.array(metric).optional(),
  video_play_actions: z.array(action).optional(),
  video_thruplay_watched_actions: z.array(action).optional(),
  actions: z.array(action).optional(),
  inline_link_clicks: z.string().optional(),
});

/** O cursor pode vir da Meta; o endereço e o token permanecem nesta fronteira. */
export async function nativeCollection<T>(
  graph: MetaGraphClient,
  path: string,
  token: string,
  query: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const parsed = z
      .object({
        data: z.array(schema).max(500),
        paging: z
          .object({
            next: z.string().optional(),
            cursors: z.object({ after: z.string().optional() }).optional(),
          })
          .optional(),
      })
      .safeParse(
        await graph.request(path, token, {
          query: { ...query, limit: "500", ...(after ? { after } : {}) },
        }),
      );
    if (!parsed.success)
      throw new MetaIntegrationError(
        "meta_provider_response_invalid",
        "A Meta devolveu dados de anúncios que não puderam ser conferidos.",
        502,
      );
    rows.push(...parsed.data.data);
    if (!parsed.data.paging?.next) return rows;
    const cursor = parsed.data.paging.cursors?.after;
    if (!cursor || cursor === after || cursor.length > 2000)
      throw new MetaIntegrationError(
        "meta_inventory_incomplete",
        "A leitura de anúncios ficou incompleta. Reduza o período ou tente novamente.",
        502,
      );
    after = cursor;
  }
  throw new MetaIntegrationError(
    "meta_inventory_incomplete",
    "Esta conta excedeu o limite desta consulta. A leitura não foi concluída.",
    422,
  );
}

export async function readNativeCampaigns(
  graph: MetaGraphClient,
  token: string,
  accountId: string,
  from: string,
  to: string,
): Promise<{ campaigns: CampanhaCrua[]; insights: LinhaDeInsightCrua[] }> {
  if (!/^(?:act_)?\d+$/.test(accountId))
    throw new MetaIntegrationError("invalid_request", "Conta de anúncios inválida.", 400);
  const path = `act_${accountId.replace(/^act_/, "")}`;
  const [campaigns, insights] = await Promise.all([
    nativeCollection(
      graph,
      `${path}/campaigns`,
      token,
      { fields: "id,name,status,effective_status,objective" },
      campaign,
    ),
    nativeCollection(
      graph,
      `${path}/insights`,
      token,
      {
        fields:
          "campaign_id,campaign_name,spend,impressions,reach,cpm,ctr,frequency,cpc,results,cost_per_result,video_play_actions,video_thruplay_watched_actions,actions,inline_link_clicks",
        level: "campaign",
        time_range: JSON.stringify({ since: from, until: to }),
      },
      insight,
    ),
  ]);
  return { campaigns, insights };
}
