import type { SupabaseClient } from "@supabase/supabase-js";

/** FKs simples validam existência, não organização. Nunca consulte só pelo id recebido. */
export async function conferirVinculosDaTarefa(
  db: SupabaseClient,
  organizationId: string,
  vinculos: { lead_id?: string | null; contact_id?: string | null },
): Promise<"aceito" | "fora_da_organizacao" | "falha_na_consulta"> {
  for (const [tabela, id] of [["crm_leads", vinculos.lead_id], ["contacts", vinculos.contact_id]] as const) {
    if (!id) continue;
    const { data, error } = await db.from(tabela).select("id")
      .eq("organization_id", organizationId).eq("id", id).maybeSingle();
    if (error) return "falha_na_consulta";
    if (!data) return "fora_da_organizacao";
  }
  return "aceito";
}
