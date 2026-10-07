import { z } from "zod";

export const metaCapabilitiesSchema = z.object({
  ads_read: z.boolean(),
  ads_manage: z.boolean(),
  instagram_publish: z.boolean(),
  instagram_message: z.boolean().optional(),
  facebook_message: z.boolean().optional(),
});
export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;
export const metaAssetKindSchema = z.enum(["page", "instagram", "ad_account"]);
export type MetaAssetKind = z.infer<typeof metaAssetKindSchema>;

/** Contrato seguro da UI. Tokens e respostas brutas não fazem parte dele. */
export interface MetaAssetDTO {
  id: string;
  kind: MetaAssetKind;
  external_id: string;
  name: string;
  username: string | null;
  currency: string | null;
  timezone: string | null;
  selected: boolean;
  capabilities: MetaCapabilities;
  unavailable_reason: string | null;
}
export const metaConnectionStatusSchema = z.enum([
  "selection_pending",
  "healthy",
  "token_expired",
  "scope_missing",
  "revoked",
  "disconnected",
  "error",
]);
export type MetaConnectionStatus = z.infer<typeof metaConnectionStatusSchema>;
export interface MetaConnectionDTO {
  id: string;
  actor_name: string;
  status: MetaConnectionStatus;
  expires_at: string | null;
  scopes: string[];
  selected_asset_count: number;
  reconnect_required: boolean;
  checked_at: string | null;
}
export interface MetaStatusDTO {
  configured: boolean;
  capabilities: MetaCapabilities;
  connections: MetaConnectionDTO[];
}

const remoteId = z
  .string()
  .regex(/^(?:act_)?\d+$/)
  .max(100);
export const metaDiscoveredAssetSchema = z.object({
  kind: metaAssetKindSchema,
  external_id: remoteId,
  name: z.string().max(500),
  parent_page_external_id: remoteId.optional(),
  currency: z.string().max(10).optional(),
  timezone: z.string().max(100).optional(),
  metadata: z.object({
    username: z.string().max(200).optional(),
    account_status: z.number().int().optional(),
    observed_at: z.iso.datetime(),
  }),
  tasks: z.array(z.string().max(100)).max(100),
  permissions: z.array(z.string().max(100)).max(100),
  page_access_token: z.string().max(10000).optional(),
});
export type MetaDiscoveredAsset = z.infer<typeof metaDiscoveredAssetSchema>;

export const metaGranularScopeSchema = z.object({
  scope: z.string().max(100),
  target_ids: z.array(remoteId).max(1000).optional(),
});
export type MetaGranularScope = z.infer<typeof metaGranularScopeSchema>;

/** Somente memória server-side ou resultado temporário cifrado. */
export const metaPendingResultSchema = z.object({
  remote_actor_id: remoteId,
  remote_actor_name: z.string().max(500),
  access_token: z.string().min(1).max(10000),
  token_type: z.string().max(100),
  token_expires_at: z.iso.datetime().nullable(),
  data_access_expires_at: z.iso.datetime().nullable(),
  scopes: z.array(z.string().max(100)).max(100),
  granular_scopes: z.array(metaGranularScopeSchema).max(100),
  assets: z.array(metaDiscoveredAssetSchema).max(1000),
});
export type MetaPendingResult = z.infer<typeof metaPendingResultSchema>;

export interface MetaNativeApp {
  appId: string | null;
  configId: string | null;
  revision: number;
  appSecret: string | null;
  apiVersion: string;
  nativeEnabled: boolean;
  instagramEnabled: boolean;
  adsEnabled: boolean;
}

export class MetaIntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
  ) {
    super(message);
    this.name = "MetaIntegrationError";
  }
}

export interface MetaMessagingChannelDTO {
  id: string;
  asset_id: string;
  platform: "instagram" | "facebook";
  status: string;
  last_error: string | null;
}
export interface MetaMessagingStatusDTO {
  channels: MetaMessagingChannelDTO[];
  webhook_url: string;
}
