import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { commercialAccountSchema, readCommercialAccount } from "@/lib/billing/entitlements";
type Context = { params: Promise<{ id: string }> };
export async function GET(_req: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return fail("validation_error", "Empresa inválida.", 400, { requestId });
  let admin;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Administração da plataforma necessária.", 403, { requestId });
  }
  try {
    return ok(
      {
        account: await readCommercialAccount(getRequestPool(), id.data),
        can_edit: admin.platformAdmin.scope === "full",
      },
      { requestId },
    );
  } catch {
    return fail("db_error", "Não foi possível carregar a classificação.", 503, { requestId });
  }
}
export async function PATCH(req: NextRequest, { params }: Context) {
  const requestId = randomUUID();
  const id = z.uuid().safeParse((await params).id);
  const body = commercialAccountSchema.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success)
    return fail("validation_error", "Confira a classificação, os limites e o período.", 400, {
      requestId,
    });
  let admin;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Administração da plataforma necessária.", 403, { requestId });
  }
  if (admin.platformAdmin.scope !== "full")
    return fail("forbidden", "Seu acesso permite somente leitura.", 403, { requestId });
  const denied = await requireSupportWrite(id.data);
  if (denied) return denied;
  const a = body.data;
  const organizationId = id.data;
  try {
    await getRequestPool().query(
      `insert into org_commercial_accounts
      (organization_id,classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,free_ai_usd_to_brl_rate,free_period_start,free_period_end,updated_by)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict(organization_id) do update set classification=excluded.classification,free_enabled=excluded.free_enabled,
      free_seats=excluded.free_seats,free_channels=excluded.free_channels,free_agents=excluded.free_agents,
      free_ai_credit_cents=excluded.free_ai_credit_cents,free_ai_usd_to_brl_rate=excluded.free_ai_usd_to_brl_rate,
      free_period_start=excluded.free_period_start,free_period_end=excluded.free_period_end,updated_by=excluded.updated_by,updated_at=now()`,
      [
        id.data,
        a.classification,
        a.free_enabled,
        a.free_seats,
        a.free_channels,
        a.free_agents,
        a.free_ai_credit_cents,
        a.free_ai_usd_to_brl_rate,
        a.free_period_start,
        a.free_period_end,
        admin.user.id,
      ],
    );
    void audit({
      action: "platform_admin.commercial_account_updated",
      actorUserId: admin.user.id,
      organizationId: id.data,
      resourceType: "org_commercial_accounts",
      resourceId: organizationId,
      requestId,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      metadata: a,
    });
    return ok({ account: await readCommercialAccount(getRequestPool(), id.data) }, { requestId });
  } catch {
    return fail(
      "state_conflict",
      "Não foi possível salvar. Confira a empresa e mantenha o período atual até encerrar os consumos pendentes.",
      409,
      { requestId },
    );
  }
}
