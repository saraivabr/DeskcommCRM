import { z } from "zod";
export const publicationInput = z
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
  })
  .strict()
  .refine(
    (v) => (v.format === "carousel" ? v.item_ids.length >= 2 : v.item_ids.length === 1),
    "Confira a quantidade de imagens.",
  );
export interface Publication {
  id: string;
  account_id: string;
  item_ids: string[];
  format: "feed" | "story" | "carousel";
  caption: string;
  status: "preparing" | "sending" | "pending" | "published" | "failed" | "uncertain";
  provider_post_id: string | null;
  permalink: string | null;
  error: string | null;
  created_at: string;
}
