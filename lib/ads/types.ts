import type { MetaCapabilities } from "@/lib/channels/meta/social/types";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

export interface NativeAdAccount {
  asset_id: string;
  connection_id: string;
  name: string;
  external_id: string;
  currency: string | null;
  timezone: string | null;
  capabilities: MetaCapabilities;
}
export interface NativeAccountsDTO {
  source: "native";
  accounts: NativeAdAccount[];
}
export interface NativeCampaignsDTO {
  source: "native";
  asset_id: string;
  connection_id: string;
  currency: string | null;
  timezone: string | null;
  campanhas: LinhaDeCampanha[];
  periodo: { from: string; to: string };
  lido_em: string;
  avisos: string[];
}

export interface AdCampaignDraftDTO {
  id: string;
  revision: number;
  status: "draft" | "approved" | "submitted" | "archived";
  connection_id: string;
  ad_account_asset_id: string;
  page_asset_id: string;
  name: string;
  objective: "OUTCOME_TRAFFIC";
  destination_url: string;
  daily_budget_cents: number;
  currency: "BRL" | "USD" | "EUR";
  starts_at: string;
  ends_at: string;
  creative: { studio_item_id: string; message: string; title: string };
  review_hash: string;
  approved_hash: string | null;
  operation: AdOperationDTO | null;
}
export interface AdOperationDTO {
  id: string;
  status:
    | "queued"
    | "executing"
    | "awaiting_provider"
    | "succeeded"
    | "failed"
    | "uncertain"
    | "blocked"
    | "cancelled";
  stage: string;
  external_ids: Record<string, string>;
  error_message: string | null;
}
export interface AdDraftContextDTO {
  drafts: AdCampaignDraftDTO[];
  pages: { asset_id: string; connection_id: string; name: string }[];
  images: { id: string; name: string; preview_url: string | null }[];
}
