import { z } from "zod";
import { MetaConnectionStore } from "@/lib/channels/meta/social/store";
import { getPlatformMetaAppNative } from "@/lib/channels/meta/app";
import { resolveMetaAsset } from "@/lib/channels/meta/social/operations";
import { MetaGraphClient } from "@/lib/channels/meta/social/graph";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import { readNativeCampaigns } from "@/lib/plataformas-de-anuncio/meta/native-insights";
import { montarTabelaDeCampanhas } from "@/lib/plataformas-de-anuncio/meta/tabela-de-campanhas";
import type { NativeAccountsDTO, NativeCampaignsDTO } from "./types";

export const nativeCampaignQuery = z
  .object({
    source: z.literal("native"),
    asset_id: z.uuid(),
    connection_id: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .strict()
  .refine(
    (v) => v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 365,
    "Confira um período de até 366 dias.",
  );

export async function nativeAdAccounts(organizationId: string): Promise<NativeAccountsDTO> {
  const app = await getPlatformMetaAppNative();
  const store = new MetaConnectionStore();
  const status = await store.status(
    organizationId,
    app,
    Boolean(app.nativeEnabled && app.appId && app.configId && app.appSecret),
  );
  const inventories = await Promise.all(
    status.connections
      .filter((c) => c.status === "healthy")
      .map(async (connection) => ({
        connection,
        assets: await store.assets(organizationId, connection.id, app),
      })),
  );
  return {
    source: "native",
    accounts: inventories.flatMap(({ connection, assets }) =>
      assets
        .filter((a) => a.kind === "ad_account" && a.selected && a.capabilities.ads_read)
        .map((a) => ({
          asset_id: a.id,
          connection_id: connection.id,
          name: a.name,
          external_id: a.external_id,
          currency: a.currency,
          timezone: a.timezone,
          capabilities: a.capabilities,
        })),
    ),
  };
}

export async function nativeCampaigns(
  organizationId: string,
  input: z.infer<typeof nativeCampaignQuery>,
): Promise<NativeCampaignsDTO> {
  const binding = await resolveMetaAsset(
    organizationId,
    input.asset_id,
    "ads_read",
    input.connection_id,
  );
  const read = await readNativeCampaigns(
    new MetaGraphClient(binding.app),
    binding.token,
    binding.asset.external_id,
    input.from,
    input.to,
  );
  const current = await resolveMetaAsset(
    organizationId,
    input.asset_id,
    "ads_read",
    input.connection_id,
  );
  if (current.authorizationVersion !== binding.authorizationVersion)
    throw new MetaIntegrationError(
      "meta_authorization_changed",
      "A autorização mudou durante a leitura. Atualize as contas.",
      409,
    );
  return {
    source: "native",
    asset_id: input.asset_id,
    connection_id: binding.connectionId,
    currency: binding.asset.currency,
    timezone: binding.asset.timezone,
    campanhas: montarTabelaDeCampanhas(read.campaigns, read.insights),
    periodo: { from: input.from, to: input.to },
    lido_em: new Date().toISOString(),
    avisos: [],
  };
}
