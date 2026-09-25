import type pg from "pg";
import { z } from "zod";

export const COMMERCIAL_ACCOUNT_CLASSIFICATIONS = [
  "legacy_unclassified",
  "internal",
  "demo",
  "courtesy",
  "external_contract",
  "free_public",
  "paid",
] as const;
export type CommercialAccountClassification = (typeof COMMERCIAL_ACCOUNT_CLASSIFICATIONS)[number];
const nullableCount = z.number().int().min(0).max(100000).nullable();
export const commercialAccountSchema = z
  .object({
    classification: z.enum(COMMERCIAL_ACCOUNT_CLASSIFICATIONS),
    free_enabled: z.boolean(),
    free_seats: z.number().int().min(1).max(100000).nullable(),
    free_channels: nullableCount,
    free_agents: nullableCount,
    free_ai_credit_cents: z.number().int().positive().max(100000000).nullable(),
    free_ai_usd_to_brl_rate: z.number().positive().max(100000).nullable(),
    free_period_start: z.iso.datetime().nullable(),
    free_period_end: z.iso.datetime().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.free_enabled) return;
    if (
      value.classification !== "free_public" ||
      Object.values(value).some((v) => v === null) ||
      Date.parse(value.free_period_start!) >= Date.parse(value.free_period_end!)
    ) {
      context.addIssue({
        code: "custom",
        message: "Para ativar o Free, informe limites, crédito, tarifa e um período válido.",
      });
    }
  });
export type CommercialAccount = z.infer<typeof commercialAccountSchema>;
export const DEFAULT_COMMERCIAL_ACCOUNT: CommercialAccount = {
  classification: "legacy_unclassified",
  free_enabled: false,
  free_seats: null,
  free_channels: null,
  free_agents: null,
  free_ai_credit_cents: null,
  free_ai_usd_to_brl_rate: null,
  free_period_start: null,
  free_period_end: null,
};
export async function readCommercialAccount(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<CommercialAccount> {
  const { rows } = await db.query<CommercialAccount>(
    `select classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,
     free_ai_usd_to_brl_rate::float8,free_period_start::text,free_period_end::text
     from org_commercial_accounts where organization_id=$1`,
    [organizationId],
  );
  const row = rows[0];
  return row
    ? {
        ...row,
        free_period_start: row.free_period_start
          ? new Date(row.free_period_start).toISOString()
          : null,
        free_period_end: row.free_period_end ? new Date(row.free_period_end).toISOString() : null,
      }
    : { ...DEFAULT_COMMERCIAL_ACCOUNT };
}
