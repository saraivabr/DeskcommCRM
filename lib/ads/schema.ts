import { z } from "zod";

// A primeira entrega trabalha apenas com moedas que usam centavos.
export const adCurrencySchema = z.enum(["BRL", "USD", "EUR"]);
export const trafficTargeting = {
  geo_locations: { countries: ["BR"] },
  age_min: 18,
  age_max: 65,
  publisher_platforms: ["facebook"],
  facebook_positions: ["feed"],
} as const;
const httpsUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Use um destino HTTPS sem credenciais.");
export const draftInputSchema = z
  .object({
    id: z.uuid(),
    connection_id: z.uuid(),
    ad_account_asset_id: z.uuid(),
    page_asset_id: z.uuid(),
    name: z.string().trim().min(1).max(200),
    destination_url: httpsUrl,
    daily_budget_cents: z.number().int().min(200).max(100000),
    currency: adCurrencySchema,
    starts_at: z.iso.datetime(),
    ends_at: z.iso.datetime(),
    creative: z
      .object({
        studio_item_id: z.uuid(),
        message: z.string().trim().min(1).max(2000),
        title: z.string().trim().min(1).max(100),
      })
      .strict(),
  })
  .strict()
  .refine((input) => {
    const duration = Date.parse(input.ends_at) - Date.parse(input.starts_at);
    return duration > 0 && duration <= 30 * 86400000;
  }, "Escolha um período de até 30 dias.");
export const draftApproveSchema = z
  .object({
    revision: z.number().int().positive(),
    review_hash: z.string().regex(/^[a-f0-9]{64}$/),
    daily_budget_cents: z.number().int().positive(),
    currency: adCurrencySchema,
  })
  .strict();
export const draftCreateSchema = z
  .object({
    revision: z.number().int().positive(),
    approved_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const draftEditSchema = draftInputSchema.safeExtend({
  revision: z.number().int().positive(),
});
export type AdDraftInput = z.infer<typeof draftInputSchema>;

/** String digitada → centavos inteiros, sem arredondar um valor diferente. */
export function parseBudgetCents(value: string): number | null {
  if (!/^\d{1,4}(?:[.,]\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return amount >= 200 && amount <= 100000 ? amount : null;
}
