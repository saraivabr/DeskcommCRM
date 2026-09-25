import type pg from "pg";

export interface AiAllowanceView {
  status: "ready" | "review" | "inactive" | "unconfirmed";
  budget: number;
  used: number;
  reserved: number;
  remaining: number;
  rate: number;
  periodStart: string | null;
  periodEnd: string | null;
}
interface Row {
  source?: "paid" | "free";
  status: string;
  current_period_start: Date | string | null;
  current_period_end: Date | string | null;
  budget: string | number | null;
  rate: string | number | null;
  used: string | number;
  reserved: string | number;
  unknown_count: string | number;
}
/** The display uses the same period and reservations as the transaction functions. */
export function allowanceView(row: Row, now = Date.now()): AiAllowanceView {
  const start = row.current_period_start ? new Date(row.current_period_start).getTime() : NaN;
  const end = row.current_period_end ? new Date(row.current_period_end).getTime() : NaN;
  const budget = Number(row.budget);
  const rate = Number(row.rate);
  const used = Number(row.used);
  const reserved = Number(row.reserved);
  const unknown = Number(row.unknown_count);
  if (
    ![budget, rate, used, reserved, unknown].every(Number.isFinite) ||
    budget <= 0 ||
    rate <= 0 ||
    used < 0 ||
    reserved < 0 ||
    unknown < 0
  )
    throw new Error("Invalid AI allowance snapshot");
  const confirmed = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const active = ["active", "trialing"].includes(row.status) && start <= now && end > now;
  return {
    status: !confirmed ? "unconfirmed" : !active ? "inactive" : unknown > 0 ? "review" : "ready",
    budget,
    rate,
    used,
    reserved,
    remaining: Math.max(0, budget - used - reserved),
    periodStart: confirmed ? new Date(start).toISOString() : null,
    periodEnd: confirmed ? new Date(end).toISOString() : null,
  };
}
/** Paid subscriptions win; only explicitly classified Free accounts use the Free cycle. */
const allowanceSource = `with allowance_source as (
 select s.organization_id,s.provider_subscription_id,s.status,s.current_period_start,s.current_period_end,
   l.ai_credit_cents as budget,l.ai_usd_to_brl_rate as rate,'paid'::text as source
 from org_subscriptions s
 left join subscription_plan_limits l on l.plan_id=s.plan_id
 where s.organization_id=$1 and s.provider_subscription_id is not null
 union all
 select c.organization_id,'free:'||c.organization_id::text,
   case when c.free_enabled then 'active' else 'pending' end,
   c.free_period_start,c.free_period_end,c.free_ai_credit_cents,c.free_ai_usd_to_brl_rate,'free'::text
 from org_commercial_accounts c
 where c.organization_id=$1 and c.classification='free_public'
   and not exists(select 1 from org_subscriptions s where s.organization_id=c.organization_id
     and s.provider_subscription_id is not null)
)`;
export async function readAiAllowance(db: Pick<pg.Pool, "query">, organizationId: string) {
  const { rows } = await db.query<Row>(
    `${allowanceSource}
     select s.source,s.status,s.current_period_start,s.current_period_end,
       coalesce(p.budget_brl_cents,s.budget) as budget,
       coalesce(p.usd_to_brl_rate,s.rate) as rate,
       coalesce(a.used,0) as used,coalesce(a.reserved,0) as reserved,
       coalesce(a.unknown_count,0) as unknown_count
     from allowance_source s
     left join subscription_ai_periods p on p.organization_id=s.organization_id
       and p.provider_subscription_id=s.provider_subscription_id
       and p.period_start=s.current_period_start
     left join lateral (
       select sum(charged_brl_cents) filter(where status='settled') as used,
              sum(reserved_brl_cents) filter(where status<>'settled') as reserved,
              count(*) filter(where status='unknown') as unknown_count
       from subscription_ai_reservations
       where organization_id=s.organization_id and period_id=p.id
     ) a on true`,
    [organizationId],
  );
  const row = rows[0];
  // A disabled Free invitation can exist before its allowance has been configured.
  if (
    row?.source === "free" &&
    row.status === "pending" &&
    (row.budget === null || row.rate === null)
  )
    return null;
  return row ? allowanceView(row) : null;
}

export interface AiUsageBreakdown {
  kind: "text" | "image" | "voice" | "other";
  operations: number;
  settledOperations: number;
  pendingOperations: number;
  commercialUsedBrlCents: number;
  reservedBrlCents: number;
  knownProviderCostUsdCents: number;
}
/** A partial known supplier cost is never represented as the full cost or commercial credit. */
export async function readAiUsageBreakdown(
  db: Pick<pg.Pool, "query">,
  organizationId: string,
): Promise<AiUsageBreakdown[]> {
  const { rows } = await db.query<{
    kind: AiUsageBreakdown["kind"];
    operations: string;
    settled: string;
    pending: string;
    commercial: string;
    reserved: string;
    provider_cost: string;
  }>(
    `${allowanceSource}
    select coalesce(r.usage_kind,'other') as kind,count(*) as operations,
      count(*) filter(where r.status='settled') as settled,
      count(*) filter(where r.status<>'settled') as pending,
      coalesce(sum(r.charged_brl_cents) filter(where r.status='settled'),0) as commercial,
      coalesce(sum(r.reserved_brl_cents) filter(where r.status<>'settled'),0) as reserved,
      coalesce(sum(r.cost_usd_cents) filter(where r.status='settled'),0) as provider_cost
    from allowance_source s
    join subscription_ai_periods p on p.organization_id=s.organization_id
      and p.provider_subscription_id=s.provider_subscription_id and p.period_start=s.current_period_start
    join subscription_ai_reservations r on r.organization_id=s.organization_id and r.period_id=p.id
    group by coalesce(r.usage_kind,'other') order by kind`,
    [organizationId],
  );
  return rows.map((row) => {
    const result: AiUsageBreakdown = {
      kind: row.kind,
      operations: Number(row.operations),
      settledOperations: Number(row.settled),
      pendingOperations: Number(row.pending),
      commercialUsedBrlCents: Number(row.commercial),
      reservedBrlCents: Number(row.reserved),
      knownProviderCostUsdCents: Number(row.provider_cost),
    };
    if (
      Object.entries(result).some(
        ([key, value]) =>
          key !== "kind" && (typeof value !== "number" || !Number.isFinite(value) || value < 0),
      )
    )
      throw new Error("Invalid AI usage snapshot");
    return result;
  });
}
