import { z } from "zod";
import {
  LEGACY_INSTAGRAM_PUBLICATION_PROVIDER,
  type InstagramPublicationProvider,
} from "@/lib/channels/social/instagram-publishing";
export const legacyPublicationInput = z
  .object({
    id: z.uuid(),
    account_id: z.string().regex(/^[a-f0-9]{24}$/),
    item_ids: z
      .array(z.uuid())
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length),
    format: z.enum(["feed", "story", "carousel"]),
    caption: z.string().max(2200),
    provider: z.literal(LEGACY_INSTAGRAM_PUBLICATION_PROVIDER).optional(),
  })
  .strict()
  .refine(
    (v) => (v.format === "carousel" ? v.item_ids.length >= 2 : v.item_ids.length === 1),
    "Confira a quantidade de imagens.",
  );
export const nativePublicationInput = z
  .object({
    id: z.uuid(),
    provider: z.literal("meta"),
    meta_asset_id: z.uuid(),
    connection_id: z.uuid(),
    item_ids: z
      .array(z.uuid())
      .min(1)
      .max(10)
      .refine((ids) => new Set(ids).size === ids.length),
    format: z.enum(["feed", "story", "carousel"]),
    caption: z.string().max(2200),
  })
  .strict()
  .refine(
    (v) => (v.format === "carousel" ? v.item_ids.length >= 2 : v.item_ids.length === 1),
    "Confira a quantidade de imagens.",
  );
export const publicationInput = z.union([legacyPublicationInput, nativePublicationInput]);
export interface Publication {
  id: string;
  account_id: string;
  provider: InstagramPublicationProvider;
  meta_asset_id: string | null;
  operation_id: string | null;
  requested_by: string | null;
  connection_id?: string;
  item_ids: string[];
  format: "feed" | "story" | "carousel";
  caption: string;
  status: "preparing" | "sending" | "pending" | "published" | "failed" | "uncertain";
  provider_post_id: string | null;
  permalink: string | null;
  error: string | null;
  created_at: string;
}
