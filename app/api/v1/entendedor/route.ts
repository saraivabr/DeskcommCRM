import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { inicioDoPeriodo, inicioDoProximoPeriodo, limiteDaOrganizacao } from "@/lib/entendedor/franquia";
import { CONFIGURACAO_PADRAO, type ConfiguracaoDoEntendedor } from "@/lib/entendedor/politica";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { entendedorPatchSchema } from "@/lib/schemas/entendedor";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const COLUNAS =
  "enabled, process_received, process_sent, groups_enabled, show_understanding, show_spoken_text, monthly_limit_seconds";

type Db = Awaited<ReturnType<typeof createClient>>;

async function lerEstado(db: Db, orgId: string) {
  // Cliente do usuário: a RLS já recorta a organização, e o filtro explícito
  // fica por clareza.
  const { data: cfg, error: cfgErr } = await db
    .from("audio_understanding_settings" as never)
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (cfgErr) throw cfgErr;
  const config: ConfiguracaoDoEntendedor = {
    ...CONFIGURACAO_PADRAO,
    ...((cfg as Partial<ConfiguracaoDoEntendedor> | null) ?? {}),
  };

  const periodo = inicioDoPeriodo();
  const { data: usos, error: usoErr } = await db
    .from("audio_understanding_usage" as never)
    .select("seconds, status, created_at")
    .eq("organization_id", orgId)
    .eq("period_start", periodo)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (usoErr) throw usoErr;
  const linhas = (usos ?? []) as Array<{ seconds: number; status: string; created_at: string }>;
  const contam = linhas.filter((l) => l.status !== "released");

  return {
    settings: config,
    usage: {
      period_start: periodo,
      renews_on: inicioDoProximoPeriodo(),
      used_seconds: contam.reduce((soma, l) => soma + l.seconds, 0),
      limit_seconds: limiteDaOrganizacao(config.monthly_limit_seconds),
      audios_understood: linhas.filter((l) => l.status === "charged").length,
      audios_failed: linhas.filter((l) => l.status === "released").length,
    },
  };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "entendedor" });
  if (!auth.ok) return auth.response;
  try {
    return ok(await lerEstado(await createClient(), auth.org.orgId), { requestId });
  } catch {
    return fail("internal_error", "Não foi possível carregar o Entendedor de áudio.", 500, { requestId });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "entendedor" });
  if (!auth.ok) return auth.response;
  const parsed = entendedorPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Confira as opções do Entendedor de áudio.", 422, { requestId });
  }

  const db = await createClient();
  const { data: atual } = await db
    .from("audio_understanding_settings" as never)
    .select(COLUNAS)
    .eq("organization_id", auth.org.orgId)
    .maybeSingle();
  const proximo = {
    ...CONFIGURACAO_PADRAO,
    ...((atual as Partial<ConfiguracaoDoEntendedor> | null) ?? {}),
    ...parsed.data,
  };
  if (!proximo.show_understanding && !proximo.show_spoken_text) {
    return fail("validation_failed", "Deixe ligado pelo menos o entendimento ou o que foi dito.", 422, { requestId });
  }
  if (!proximo.process_received && !proximo.process_sent) {
    return fail("validation_failed", "Escolha entender os áudios recebidos, os enviados ou os dois.", 422, { requestId });
  }

  const { error } = await db.from("audio_understanding_settings" as never).upsert(
    {
      organization_id: auth.org.orgId,
      enabled: proximo.enabled,
      process_received: proximo.process_received,
      process_sent: proximo.process_sent,
      show_understanding: proximo.show_understanding,
      show_spoken_text: proximo.show_spoken_text,
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    } as never,
    { onConflict: "organization_id" },
  );
  if (error) {
    const proibido = error.code === "42501";
    return fail(
      proibido ? "forbidden" : "internal_error",
      proibido ? "Só administradores mudam o Entendedor de áudio." : "Não foi possível salvar. Tente novamente.",
      proibido ? 403 : 500,
      { requestId },
    );
  }

  void audit({
    action: "entendedor.settings_updated",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "organization",
    resourceId: auth.org.orgId,
    requestId,
    metadata: parsed.data,
  });

  try {
    return ok(await lerEstado(db, auth.org.orgId), { requestId });
  } catch {
    return ok({ settings: proximo }, { requestId });
  }
}
