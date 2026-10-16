import { z } from "zod";
import { MetaNativeService } from "./service";
import { MetaConnectionStore } from "./store";
import { createBoundedMetaAdminClient } from "./bounded-admin";
import { resolveSelectedMetaAsset, type MetaAssetCapability } from "./operations";
import { MetaGraphClient } from "./graph";
import { MetaIntegrationError } from "./types";

export const nativeInstagramSelection = z.object({
  account_id: z.uuid(),
  connection_id: z.uuid(),
});
export type NativeInstagramSelection = z.infer<typeof nativeInstagramSelection>;

export async function listNativeInstagramReadAccounts(org: string, signal?: AbortSignal) {
  const service = new MetaNativeService(
    new MetaConnectionStore(createBoundedMetaAdminClient(signal)),
  );
  const status = await service.status(org);
  if (!status.configured) return [];
  const groups = await Promise.all(
    status.connections
      .filter((c) => c.status === "healthy" && !c.reconnect_required)
      .map(async (connection) => {
        const { assets } = await service.assets(org, connection.id);
        return assets
          .filter((a) => a.kind === "instagram" && a.selected && a.capabilities.instagram_read)
          .map((a) => ({
            id: a.id,
            provider: "meta" as const,
            connection_id: connection.id,
            name: a.username ?? a.name,
            active: true,
            insights_available: a.capabilities.instagram_insights === true,
          }));
      }),
  );
  return groups.flat();
}

async function selected(
  org: string,
  input: NativeInstagramSelection,
  capability: MetaAssetCapability,
  signal?: AbortSignal,
) {
  const parsed = nativeInstagramSelection.parse(input);
  const resolved = await resolveSelectedMetaAsset(
    org,
    parsed.account_id,
    capability,
    parsed.connection_id,
    createBoundedMetaAdminClient(signal),
  );
  return { resolved, graph: new MetaGraphClient(resolved.app) };
}

const metricNames = ["reach", "views", "accounts_engaged", "total_interactions"] as const;
const insightsResponse = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      id: z.string().optional(),
      total_value: z.object({ value: z.number().finite().nonnegative() }).nullish(),
    }),
  ),
});

/** Graph total_value is the period total; never sum daily unique reach or invent missing zeros. */
export async function nativeInstagramInsights(
  org: string,
  input: NativeInstagramSelection,
  signal?: AbortSignal,
  now = new Date(),
) {
  const { resolved, graph } = await selected(org, input, "instagram_insights", signal);
  const since = new Date(now.getTime() - 30 * 86400_000);
  const raw = await graph.request(`${resolved.asset.external_id}/insights`, resolved.token, {
    query: {
      metric: metricNames.join(","),
      period: "day",
      metric_type: "total_value",
      since: String(Math.floor(since.getTime() / 1000)),
      until: String(Math.floor(now.getTime() / 1000)),
    },
    signal,
  });
  const result = insightsResponse.safeParse(raw);
  if (!result.success)
    throw new MetaIntegrationError(
      "meta_provider_response_invalid",
      "A Meta não confirmou os resultados desta conta. Tente novamente.",
      502,
    );
  const metrics: Record<string, { total: number }> = {};
  for (const metric of result.data.data) {
    if (!metricNames.some((name) => name === metric.name)) continue;
    if (metric.id && !metric.id.startsWith(`${resolved.asset.external_id}/insights/`))
      throw new MetaIntegrationError(
        "meta_provider_response_invalid",
        "Os resultados não correspondem à conta selecionada.",
        502,
      );
    if (metric.total_value) metrics[metric.name] = { total: metric.total_value.value };
  }
  return {
    dateRange: { since: since.toISOString().slice(0, 10), until: now.toISOString().slice(0, 10) },
    metrics,
  };
}
