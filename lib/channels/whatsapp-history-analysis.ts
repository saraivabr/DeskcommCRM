import { createAdminClient } from "@/lib/supabase/admin";
import { loadCredential } from "@/lib/ai/credentials";
import { classifyHistoricalMessage, safeHistoricalState } from "@/lib/ai/whatsapp-history-jev";

type Pending = { id: string; organization_id: string; body: string };
type Result = { analyzed: number; ignored: number; failures: number; withoutKey: number; costUsd: number; lastError: string | null };

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(jev_http_\d{3}|jev_invalid_answer|history_jev_[a-z_0-9]+)$/.test(message)
    ? message : "history_jev_unknown";
}

async function openRouterKey(admin: ReturnType<typeof createAdminClient>, organizationId: string): Promise<string | null> {
  const { data, error } = await admin.from("ai_provider_credentials")
    .select("id").eq("organization_id", organizationId).eq("provider", "openrouter")
    .eq("is_active", true).not("validated_at", "is", null)
    .order("validated_at", { ascending: false }).limit(1);
  if (error) throw new Error(`history_jev_credential_${error.code}`);
  if (data?.[0]) return (await loadCredential(data[0].id, organizationId)).apiKey;
  return process.env.OPENROUTER_API_KEY?.trim() || null;
}

/** Lote fora do atendimento: uma falha do Jev nunca segura o Inbox nem o importador. */
export async function analyzeWhatsappHistory(): Promise<Result> {
  const admin = createAdminClient();
  const result: Result = { analyzed: 0, ignored: 0, failures: 0, withoutKey: 0, costUsd: 0, lastError: null };
  const { data: syncs, error: syncError } = await admin.from("whatsapp_history_syncs" as never)
    .select("organization_id").gt("messages_imported", 0).limit(100);
  if (syncError) throw new Error(`history_jev_syncs_${syncError.code}`);
  const organizations = [...new Set(((syncs ?? []) as Array<{ organization_id: string }>).map((s) => s.organization_id))];
  for (const organizationId of organizations) {
    if (result.analyzed + result.ignored >= 20) break;
    const { data: pending, error: pendingError } = await admin.from("whatsapp_history_pending_analysis" as never)
      .select("id,organization_id,body").eq("organization_id", organizationId)
      .order("imported_at", { ascending: true }).limit(5);
    if (pendingError) { result.failures++; result.lastError = "history_jev_pending_read"; continue; }
    const rows = (pending ?? []) as Pending[];
    if (!rows.length) continue;
    let key: string | null;
    try { key = await openRouterKey(admin, organizationId); }
    catch (error) { result.failures++; result.lastError = errorCode(error); continue; }
    if (!key) { result.withoutKey++; continue; }
    const { data: org, error: orgError } = await admin.from("organizations")
      .select("country").eq("id", organizationId).maybeSingle();
    if (orgError || !org) { result.failures++; result.lastError = "history_jev_org_read"; continue; }
    const outcomes = await Promise.allSettled(rows.map(async (row) => {
      const safe = safeHistoricalState(row.body, org.country);
      const decision = safe ? await classifyHistoricalMessage(safe, key) :
        { intent: "ignorado", objection: "ignorado", confidence: 0, cost_usd: 0 };
      const { error } = await admin.from("whatsapp_history_analysis" as never).upsert({
        organization_id: organizationId, message_id: row.id, ...decision,
      } as never, { onConflict: "message_id", ignoreDuplicates: true });
      if (error) throw new Error(`history_jev_write_${error.code}`);
      return decision;
    }));
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") { result.failures++; result.lastError = errorCode(outcome.reason); continue; }
      if (outcome.value.intent === "ignorado") result.ignored++;
      else result.analyzed++;
      result.costUsd += outcome.value.cost_usd;
    }
  }
  return result;
}
