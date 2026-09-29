import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { operationalApprovalDetails as review } from "@/lib/mcp/approval-details";

function operationalApprovalDetails(
  db: SupabaseClient,
  orgId: string,
  idioma: Parameters<typeof review>[2],
  action: Parameters<typeof review>[3],
  reviewer: Parameters<typeof review>[4] = {
    userId: "11111111-1111-4111-8111-111111111111",
    role: "manager",
  },
) {
  return review(db, orgId, idioma, action, reviewer);
}

type Row = Record<string, unknown>;
function database(tables: Record<string, Row[]> = {}) {
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const db = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      reads.push({ table, filters });
      const query = {
        select() {
          return query;
        },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return query;
        },
        async maybeSingle() {
          return {
            data:
              tables[table]?.find((row) => filters.every(([key, value]) => row[key] === value)) ??
              null,
            error: null,
          };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { db, reads };
}
const tenant = { organization_id: "own-org" };

describe("personal operation approval details", () => {
  it("shows the actual patch and destination stage using tenant-filtered names", async () => {
    const { db, reads } = database({
      crm_leads: [{ ...tenant, id: "lead", title: "Consultoria", contact_id: "contact" }],
      crm_stages: [{ ...tenant, id: "stage", name: "Qualificado" }],
    });
    const patch = await operationalApprovalDetails(db, "own-org", "pt-BR", {
      tool_name: "crm_update_lead",
      args: { lead_id: "lead", value_cents: 35000, custom_fields: { objetivo: "Agenda" } },
    });
    expect(patch).toMatchObject({
      resource_title: "Consultoria (lead)",
      resource_url: "/app/leads/lead",
    });
    expect(patch?.summary).toContain("Valor em centavos: 35000");
    expect(patch?.summary).toContain('Campos personalizados: {"objetivo":"Agenda"}');
    const move = await operationalApprovalDetails(db, "own-org", "es", {
      tool_name: "crm_move_lead_stage",
      args: { lead_id: "lead", to_stage_id: "stage", reason: "Cliente respondeu" },
    });
    expect(move?.summary).toContain("Etapa de destino: Qualificado (stage)");
    expect(move?.summary).toContain("Motivo: Cliente respondeu");
    for (const query of reads) expect(query.filters).toContainEqual(["organization_id", "own-org"]);
  });
  it("never renders a resource name from another tenant", async () => {
    const { db } = database({
      crm_leads: [{ organization_id: "other-org", id: "lead", title: "Private victim" }],
    });
    const result = await operationalApprovalDetails(db, "own-org", "pt-BR", {
      tool_name: "crm_update_lead",
      args: { lead_id: "lead", title: "Requested title" },
    });
    expect(result?.resource_title).toBe("Recurso indisponível (lead)");
    expect(JSON.stringify(result)).not.toContain("Private victim");
  });
  it("does not reread CRM names after the reviewer loses the required management role", async () => {
    const { db, reads } = database({
      crm_leads: [{ ...tenant, id: "lead", title: "Previously accessible" }],
    });
    const result = await operationalApprovalDetails(
      db,
      "own-org",
      "es",
      { tool_name: "crm_update_lead", args: { lead_id: "lead", title: "Requested" } },
      { userId: "11111111-1111-4111-8111-111111111111", role: "agent" },
    );
    expect(result?.summary).toContain("requiere acceso de gerente");
    expect(reads).toEqual([]);
  });
  it("shows the new lead destination, contact and full requested values before creation", async () => {
    const { db } = database({
      contacts: [{ ...tenant, id: "contact", name: "Cliente" }],
      crm_pipelines: [{ ...tenant, id: "pipeline", name: "Vendas" }],
      crm_stages: [{ ...tenant, id: "stage", name: "Entrada" }],
    });
    const result = await operationalApprovalDetails(db, "own-org", "es", {
      tool_name: "crm_create_lead",
      args: {
        pipeline_id: "pipeline",
        stage_id: "stage",
        contact_id: "contact",
        title: "Interesse novo",
        tags: ["vip"],
      },
    });
    expect(result?.summary).toContain("Embudo: Vendas (pipeline)");
    expect(result?.summary).toContain("Cliente: Cliente (contact)");
    expect(result?.summary).toContain('Etiquetas: ["vip"]');
  });
  it("makes relative scheduling explicit and shows the actual reason and promise", async () => {
    const { db } = database({ contacts: [{ ...tenant, id: "contact", name: "Ana" }] });
    const result = await operationalApprovalDetails(db, "own-org", "es", {
      tool_name: "crm_schedule_followup",
      args: {
        contact_id: "contact",
        in_hours: 24,
        promised_at: "ignored",
        reason: "Pediu tempo",
        promise: "Enviar proposta",
      },
    });
    expect(result?.resource_title).toBe("Ana (contact)");
    expect(result?.summary).toContain("24 horas después de ejecutar la operación aprobada");
    expect(result?.summary).toContain("Promesa al cliente: Enviar proposta");
    expect(result?.summary).not.toContain("ignored");
  });
  it("keeps the approved followup recipient fixed when the lead contact changes", async () => {
    const { db, reads } = database({
      crm_leads: [{ ...tenant, id: "lead", contact_id: "new-contact" }],
      contacts: [
        { ...tenant, id: "approved-contact", name: "Ana" },
        { ...tenant, id: "new-contact", name: "Different person" },
      ],
    });
    const result = await operationalApprovalDetails(db, "own-org", "pt-BR", {
      tool_name: "crm_schedule_followup",
      args: {
        lead_id: "lead",
        contact_id: "approved-contact",
        in_hours: 24,
        reason: "Enviar proposta",
        promise: "Volto amanhã",
      },
    });
    expect(result?.resource_title).toBe("Ana (approved-contact)");
    expect(JSON.stringify(result)).not.toContain("Different person");
    expect(reads.filter((read) => read.table === "contacts")).toEqual([
      {
        table: "contacts",
        filters: [
          ["organization_id", "own-org"],
          ["id", "approved-contact"],
        ],
      },
    ]);
  });
  it("restricts cancellation review to a followup cron job and includes its time", async () => {
    const { db, reads } = database({
      cron_jobs: [
        {
          ...tenant,
          id: "return",
          kind: "at",
          job_kind: "followup_turn",
          contact_id: "contact",
          next_run_at: "2026-10-01T14:00:00Z",
        },
      ],
      contacts: [{ ...tenant, id: "contact", name: "Ana" }],
    });
    const result = await operationalApprovalDetails(db, "own-org", "pt-BR", {
      tool_name: "crm_cancel_followup",
      args: { followup_id: "return", reason: "Já respondeu" },
    });
    expect(result?.summary).toContain("2026-10-01T14:00:00Z");
    expect(result?.summary).toContain("Motivo: Já respondeu");
    const jobQuery = reads[0];
    expect(jobQuery).toBeDefined();
    if (!jobQuery) throw new Error("Expected a followup lookup");
    expect(jobQuery.filters).toContainEqual(["kind", "at"]);
    expect(jobQuery.filters).toContainEqual(["job_kind", "followup_turn"]);
  });
  it("shows booking details, current appointment and the requested outcome in Spanish", async () => {
    const { db } = database({
      contacts: [{ ...tenant, id: "contact", name: "Ana" }],
      calendar_event_types: [
        { ...tenant, slug: "consulta", name: "Consulta inicial", requires_confirmation: true },
      ],
      calendar_appointments: [
        {
          ...tenant,
          id: "appointment",
          title: "Consulta Ana",
          contact_id: "contact",
          starts_at: "2026-10-01T14:00:00Z",
          status: "confirmed",
          time_zone: "America/Sao_Paulo",
        },
      ],
    });
    const booking = await operationalApprovalDetails(db, "own-org", "es", {
      tool_name: "crm_find_and_book_appointment",
      args: {
        event_type_slug: "consulta",
        contact_id: "contact",
        dia: "2026-10-01",
        horario: "11:00",
        notes: "Nota interna",
      },
    });
    expect(booking?.summary).toContain("Hora en la zona horaria de la agenda: 11:00");
    expect(booking?.summary).toContain("Notas internas: Nota interna");
    expect(booking?.summary).toContain("requiere confirmación del equipo");
    const result = await operationalApprovalDetails(db, "own-org", "es", {
      tool_name: "crm_set_appointment_outcome",
      args: { appointment_id: "appointment", outcome: "no_show", notes: "Conferido" },
    });
    expect(result?.summary).toContain("Inicio actual: 2026-10-01T14:00:00Z");
    expect(result?.summary).toContain("La persona no asistió");
    expect(result?.resource_url).toBe("/app/agenda?compromisso=appointment");
  });
  it("describes credit consumption and a draft without promising a WhatsApp send", async () => {
    const { db } = database({
      conversations: [{ ...tenant, id: "conversation", contact_id: "contact" }],
      contacts: [{ ...tenant, id: "contact", name: "Ana" }],
    });
    const result = await operationalApprovalDetails(
      db,
      "own-org",
      "pt-BR",
      { tool_name: "crm_generate_reply_draft", args: { conversation_id: "conversation" } },
      { userId: "11111111-1111-4111-8111-111111111111", role: "manager" },
    );
    expect(result?.summary).toContain("créditos de IA");
    expect(result?.summary).toContain("rascunho para revisão");
    expect(result?.resource_url).toBe("/app/inbox?id=conversation");
  });
  it("hides the client identity on a draft approval after conversation visibility is lost", async () => {
    const { db, reads } = database({
      organizations: [{ id: "own-org", settings: { visibility_mode: "own" } }],
      conversations: [
        { ...tenant, id: "conversation", contact_id: "contact", assigned_to_user_id: "other-user" },
      ],
      contacts: [{ ...tenant, id: "contact", name: "Private client" }],
    });
    const result = await operationalApprovalDetails(
      db,
      "own-org",
      "pt-BR",
      { tool_name: "crm_generate_reply_draft", args: { conversation_id: "conversation" } },
      { userId: "11111111-1111-4111-8111-111111111111", role: "agent" },
    );
    expect(result?.resource_title).toBe("Recurso indisponível (conversation)");
    expect(reads.some((query) => query.table === "contacts")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Private client");
  });
});
