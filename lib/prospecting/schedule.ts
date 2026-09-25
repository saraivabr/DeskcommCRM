import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { scheduleConfigSchema, type ScheduleConfig } from "./schema";
import { ProspectingError } from "./provider";
import {
  activateCampaignWithClient,
  createSearchWithClient,
  credential,
  validateConfig,
  withProspectingLock,
  type Campaign,
} from "./store";

export interface ProspectingSchedule {
  schedule_config: ScheduleConfig | null;
  schedule_enabled: boolean;
  schedule_runs: number;
  schedule_reserved_usd: string;
  schedule_next_at: string | null;
  schedule_request_id: string | null;
  schedule_campaign_id: string | null;
  schedule_error: string | null;
}

export function hasSearchBudget(config: ScheduleConfig, runs: number, reserved: number) {
  return (
    runs < config.max_runs &&
    Math.round((reserved + config.search.budget_usd) * 100) <=
      Math.round(config.total_budget_usd * 100)
  );
}

export async function saveSchedule(pool: pg.Pool, org: string, input: ScheduleConfig) {
  const config = scheduleConfigSchema.parse(input);
  return withProspectingLock(pool, org, async (db) => {
    const busy = await db.query(
      "select 1 from prospecting_settings s join prospecting_campaigns c on c.organization_id=s.organization_id and c.id=s.schedule_campaign_id where s.organization_id=$1 and (c.status='running' or c.search_status in ('starting','running'))",
      [org],
    );
    if (busy.rows.length)
      throw new ProspectingError(
        "Pare a recorrência e aguarde a busca atual terminar antes de editar.",
        409,
      );
    const result = await db.query(
      "update prospecting_settings set schedule_config=$2,schedule_enabled=false,schedule_runs=0,schedule_reserved_usd=0,schedule_next_at=null,schedule_request_id=null,schedule_campaign_id=null,schedule_error=null,updated_at=now() where organization_id=$1 returning organization_id",
      [org, config],
    );
    if (!result.rows.length)
      throw new ProspectingError("Configure a chave de busca antes de salvar a recorrência.");
    return { saved: true, enabled: false };
  });
}

export async function enableSchedule(pool: pg.Pool, admin: SupabaseClient, org: string) {
  return withProspectingLock(pool, org, async (db) => {
    const row = (
      await db.query<ProspectingSchedule>(
        "select * from prospecting_settings where organization_id=$1",
        [org],
      )
    ).rows[0];
    const parsed = scheduleConfigSchema.safeParse(row?.schedule_config);
    if (!row || !parsed.success)
      throw new ProspectingError("Salve os parâmetros da recorrência antes de ativar.");
    if (row.schedule_enabled) return { enabled: true };
    if (row.schedule_request_id || row.schedule_campaign_id)
      throw new ProspectingError(
        "Confira o último lote e salve uma nova configuração antes de reativar.",
      );
    if (!hasSearchBudget(parsed.data, row.schedule_runs, Number(row.schedule_reserved_usd)))
      throw new ProspectingError(
        "O limite da recorrência foi atingido. Revise e salve novos limites.",
      );
    await credential(db, admin, org);
    if (parsed.data.campaign_config) await validateConfig(db, org, parsed.data.campaign_config);
    await db.query(
      "update prospecting_settings set schedule_enabled=true,schedule_next_at=now(),schedule_error=null,updated_at=now() where organization_id=$1",
      [org],
    );
    return { enabled: true };
  });
}

/** Immediate stop, including an in-flight model's last-moment delivery guard. A paid request already submitted may still finish. */
export async function stopSchedule(pool: pg.Pool, org: string) {
  await pool.query(
    "with stopped as (update prospecting_settings set schedule_enabled=false,schedule_error='Recorrência parada pelo responsável.',updated_at=now() where organization_id=$1 returning schedule_campaign_id) update prospecting_campaigns set status='paused',updated_at=now() where organization_id=$1 and id in(select schedule_campaign_id from stopped) and status in ('draft','running')",
    [org],
  );
  return { enabled: false };
}

export async function tickSchedules(pool: pg.Pool, admin: SupabaseClient) {
  const rows = (
    await pool.query<{ organization_id: string }>(
      "select organization_id from prospecting_settings where schedule_enabled order by schedule_next_at nulls first limit 5",
    )
  ).rows;
  const deadline = Date.now() + 60000;
  let processed = 0;
  for (const { organization_id: org } of rows) {
    if (Date.now() >= deadline) break;
    try {
      await withProspectingLock(pool, org, async (db) => {
        const s = (
          await db.query<ProspectingSchedule>(
            "select * from prospecting_settings where organization_id=$1 and schedule_enabled",
            [org],
          )
        ).rows[0];
        if (!s) return;
        try {
          const cfg = scheduleConfigSchema.parse(s.schedule_config);
          if (s.schedule_campaign_id) {
            const c = (
              await db.query<Campaign>(
                "select * from prospecting_campaigns where organization_id=$1 and id=$2",
                [org, s.schedule_campaign_id],
              )
            ).rows[0];
            if (!c || ["failed", "unknown"].includes(c.search_status) || c.status === "paused")
              throw new ProspectingError("O último lote exige revisão. A recorrência foi parada.");
            if (c.search_status !== "succeeded" || c.status === "running") return;
            if (cfg.campaign_config && c.status === "draft") {
              await activateCampaignWithClient(db, admin, org, c.id, cfg.campaign_config, true);
              processed++;
              await audit({
                action: "prospecting.changed",
                organizationId: org,
                actorUserId: null,
                resourceType: "prospecting",
                resourceId: c.id,
                metadata: { operation: "schedule_campaign_started" },
              });
              return;
            }
            // Empty batches stop the loop, instead of spending again on the same exhausted audience.
            const count = await db.query(
              "select 1 from prospecting_candidates where organization_id=$1 and campaign_id=$2 limit 1",
              [org, c.id],
            );
            if (!count.rows.length)
              throw new ProspectingError(
                "A busca não trouxe novas empresas. Revise o público antes de reativar.",
              );
            await db.query(
              "update prospecting_settings set schedule_campaign_id=null,schedule_request_id=null where organization_id=$1",
              [org],
            );
            processed++;
            await audit({
              action: "prospecting.changed",
              organizationId: org,
              actorUserId: null,
              resourceType: "prospecting",
              resourceId: c.id,
              metadata: { operation: "scheduled_batch_completed" },
            });
            s.schedule_campaign_id = null;
            s.schedule_request_id = null;
          }
          if (!s.schedule_request_id) {
            if (!hasSearchBudget(cfg, s.schedule_runs, Number(s.schedule_reserved_usd)))
              throw new ProspectingError("Limite de execuções ou de gasto reservado atingido.");
            if (s.schedule_next_at && new Date(s.schedule_next_at).getTime() > Date.now()) return;
            if (
              (
                await db.query(
                  "select 1 from prospecting_campaigns where organization_id=$1 and (status='running' or search_status in ('starting','running')) limit 1",
                  [org],
                )
              ).rows.length
            )
              return;
            await credential(db, admin, org);
            if (cfg.campaign_config) await validateConfig(db, org, cfg.campaign_config);
            s.schedule_request_id = randomUUID();
            // Reserve the full per-run ceiling BEFORE the external POST. Never release uncertain spend.
            const claimed = await db.query(
              "update prospecting_settings set schedule_request_id=$2,schedule_runs=schedule_runs+1,schedule_reserved_usd=schedule_reserved_usd+$3,schedule_next_at=now()+make_interval(hours=>$4),updated_at=now() where organization_id=$1 and schedule_enabled returning organization_id",
              [org, s.schedule_request_id, cfg.search.budget_usd, cfg.interval_hours],
            );
            if (!claimed.rows.length) return;
          }
          const campaign = await createSearchWithClient(
            db,
            admin,
            org,
            s.schedule_request_id,
            cfg.search,
          );
          await db.query(
            "update prospecting_settings set schedule_campaign_id=$2,updated_at=now() where organization_id=$1",
            [org, campaign.id],
          );
          processed++;
          await audit({
            action: "prospecting.changed",
            organizationId: org,
            actorUserId: null,
            resourceType: "prospecting",
            resourceId: campaign.id,
            metadata: { operation: "scheduled_search", reserved_usd: cfg.search.budget_usd },
          });
          if (["failed", "unknown"].includes(campaign.search_status))
            throw new ProspectingError(
              "A busca não foi confirmada. Confira o provedor antes de reativar.",
            );
        } catch (error) {
          const message =
            error instanceof ProspectingError
              ? error.message
              : "Falha na recorrência. Confira a configuração e o último lote antes de reativar.";
          await db.query(
            "update prospecting_settings set schedule_enabled=false,schedule_error=$2,updated_at=now() where organization_id=$1",
            [org, message],
          );
          processed++;
          await audit({
            action: "prospecting.changed",
            organizationId: org,
            actorUserId: null,
            resourceType: "prospecting",
            metadata: { operation: "schedule_stopped", reason: message },
          });
        }
      });
    } catch (error) {
      if (!(error instanceof ProspectingError && error.status === 409)) throw error;
    }
  }
  return processed;
}
