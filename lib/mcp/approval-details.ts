import type { SupabaseClient } from "@supabase/supabase-js";
import type { Idioma } from "@/lib/i18n/idiomas";
import { roleAtLeast, type Role } from "@/lib/auth/types";
import { canViewConversation, conversationAccess } from "./resource-access";
import type { McpContext } from "./types";

type Action = { tool_name: string; args: Record<string, unknown> };
export type ApprovalDetails = {
  resource_title: string;
  summary: string;
  resource_url: string;
};

const FIELDS: Record<string, [string, string]> = {
  title: ["Título", "Título"],
  description: ["Descrição", "Descripción"],
  value_cents: ["Valor em centavos", "Importe en centavos"],
  currency: ["Moeda", "Moneda"],
  owner_user_id: ["Responsável", "Responsable"],
  owner_agent_id: ["Agente responsável", "Agente responsable"],
  expected_close_date: ["Previsão de fechamento", "Fecha prevista de cierre"],
  tags: ["Marcadores", "Etiquetas"],
  source: ["Origem", "Origen"],
  custom_fields: ["Campos personalizados", "Campos personalizados"],
  reason: ["Motivo", "Motivo"],
  promise: ["Promessa ao cliente", "Promesa al cliente"],
  context: ["Contexto", "Contexto"],
  promised_at: ["Retorno no instante", "Seguimiento en el instante"],
  starts_at: ["Início", "Inicio"],
  new_starts_at: ["Novo início", "Nuevo inicio"],
  dia: ["Dia no fuso da agenda", "Día en la zona horaria de la agenda"],
  horario: ["Hora no fuso da agenda", "Hora en la zona horaria de la agenda"],
  notes: ["Anotações internas", "Notas internas"],
  location_details: ["Local", "Lugar"],
  position_in_stage: ["Posição na etapa", "Posición en la etapa"],
  expected_reply_context_revision: [
    "Revisão da conversa utilizada",
    "Revisión de la conversación utilizada",
  ],
};

/** Review the concrete effect, using only tenant-filtered names and the bound request arguments. */
export async function operationalApprovalDetails(
  db: SupabaseClient,
  organizationId: string,
  idioma: Idioma,
  action: Action,
  reviewer: { userId: string; role: Role },
): Promise<ApprovalDetails | null> {
  const args = action.args;
  const es = idioma === "es";
  const text = (pt: string, spanish: string) => (es ? spanish : pt);
  const unavailable = text("Recurso indisponível", "Recurso no disponible");
  const managed = new Set([
    "crm_create_lead",
    "crm_update_lead",
    "crm_move_lead_stage",
    "crm_schedule_followup",
    "crm_cancel_followup",
    "crm_book_appointment",
    "crm_find_and_book_appointment",
    "crm_reschedule_appointment",
    "crm_cancel_appointment",
    "crm_confirm_appointment",
    "crm_set_appointment_outcome",
  ]);
  if (managed.has(action.tool_name) && !roleAtLeast(reviewer.role, "manager"))
    return {
      resource_title: unavailable,
      summary: text(
        "Esta operação exige acesso de gerente ou administrador.",
        "Esta operación requiere acceso de gerente o administrador.",
      ),
      resource_url: "/app/settings/ai-connections",
    };
  async function lookup(table: string, key: string, value: unknown, columns: string) {
    if (typeof value !== "string") return null;
    const { data, error } = await db
      .from(table)
      .select(columns)
      .eq("organization_id", organizationId)
      .eq(key, value)
      .maybeSingle();
    if (error)
      throw new Error(
        text("Não foi possível preparar a revisão.", "No se pudo preparar la revisión."),
      );
    return data as Record<string, unknown> | null;
  }
  function value(input: unknown): string {
    return typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  }
  function named(row: Record<string, unknown> | null, key: string, id: unknown): string {
    return `${typeof row?.[key] === "string" ? row[key] : unavailable} (${value(id)})`;
  }
  function fields(keys: string[]): string[] {
    return keys.flatMap((key) => {
      if (args[key] === undefined) return [];
      const label = FIELDS[key];
      if (!label) throw new Error("Campo de revisão não cadastrado.");
      return [`${label[es ? 1 : 0]}: ${value(args[key])}`];
    });
  }
  async function contact(id: unknown): Promise<string> {
    const row = await lookup("contacts", "id", id, "name,display_name");
    return named(
      row,
      typeof row?.display_name === "string" && row.display_name ? "display_name" : "name",
      id,
    );
  }
  async function lead() {
    return lookup("crm_leads", "id", args.lead_id, "title,pipeline_id,contact_id");
  }
  const editFields = [
    "title",
    "description",
    "value_cents",
    "currency",
    "owner_user_id",
    "owner_agent_id",
    "expected_close_date",
    "tags",
    "custom_fields",
  ];
  if (["crm_create_lead", "crm_update_lead", "crm_move_lead_stage"].includes(action.tool_name)) {
    const current = action.tool_name === "crm_create_lead" ? null : await lead();
    const lines: string[] = [];
    if (args.contact_id !== undefined)
      lines.push(`${text("Cliente", "Cliente")}: ${await contact(args.contact_id)}`);
    if (action.tool_name === "crm_create_lead") {
      const pipeline = await lookup("crm_pipelines", "id", args.pipeline_id, "name");
      const stage = await lookup("crm_stages", "id", args.stage_id, "name");
      lines.push(`${text("Funil", "Embudo")}: ${named(pipeline, "name", args.pipeline_id)}`);
      lines.push(
        `${text("Etapa inicial", "Etapa inicial")}: ${named(stage, "name", args.stage_id)}`,
      );
      lines.push(...fields([...editFields, "source"]));
    } else if (action.tool_name === "crm_update_lead") {
      lines.push(...fields(editFields));
    } else {
      const stage = await lookup("crm_stages", "id", args.to_stage_id, "name");
      lines.push(
        `${text("Etapa de destino", "Etapa de destino")}: ${named(stage, "name", args.to_stage_id)}`,
      );
      lines.push(...fields(["reason", "position_in_stage"]));
    }
    return {
      resource_title:
        action.tool_name === "crm_create_lead"
          ? value(args.title)
          : named(current, "title", args.lead_id),
      summary: lines.join("\n"),
      resource_url:
        action.tool_name === "crm_create_lead"
          ? `/app/pipelines/${encodeURIComponent(value(args.pipeline_id))}`
          : `/app/leads/${encodeURIComponent(value(args.lead_id))}`,
    };
  }
  if (action.tool_name === "crm_schedule_followup") {
    const target = await contact(args.contact_id);
    const lines = [
      text(
        "O agente voltará a falar com este cliente.",
        "El agente volverá a contactar a este cliente.",
      ),
    ];
    if (args.in_hours !== undefined) {
      lines.push(
        text(
          `Retorno: ${value(args.in_hours)} horas após executar a operação aprovada.`,
          `Seguimiento: ${value(args.in_hours)} horas después de ejecutar la operación aprobada.`,
        ),
      );
    } else lines.push(...fields(["promised_at"]));
    lines.push(...fields(["reason", "promise", "context"]));
    return { resource_title: target, summary: lines.join("\n"), resource_url: "/app/radar" };
  }
  if (action.tool_name === "crm_cancel_followup") {
    const { data, error } = await db
      .from("cron_jobs")
      .select("contact_id,next_run_at")
      .eq("organization_id", organizationId)
      .eq("id", args.followup_id)
      .eq("kind", "at")
      .eq("job_kind", "followup_turn")
      .maybeSingle();
    if (error)
      throw new Error(
        text("Não foi possível preparar a revisão.", "No se pudo preparar la revisión."),
      );
    return {
      resource_title: data
        ? await contact(data.contact_id)
        : `${unavailable} (${value(args.followup_id)})`,
      summary: [
        `${text("Retorno agendado", "Seguimiento programado")}: ${data?.next_run_at ?? unavailable}`,
        ...fields(["reason"]),
      ].join("\n"),
      resource_url: "/app/radar",
    };
  }
  if (["crm_book_appointment", "crm_find_and_book_appointment"].includes(action.tool_name)) {
    const eventType = await lookup(
      "calendar_event_types",
      "slug",
      args.event_type_slug,
      "name,requires_confirmation",
    );
    const lines = [
      `${text("Tipo de atendimento", "Tipo de atención")}: ${named(eventType, "name", args.event_type_slug)}`,
      ...fields([
        "starts_at",
        "dia",
        "horario",
        "owner_user_id",
        "title",
        "notes",
        "description",
        "location_details",
      ]),
    ];
    if (eventType?.requires_confirmation)
      lines.push(
        text(
          "A agenda também exige confirmação da equipe para este atendimento.",
          "La agenda también requiere confirmación del equipo para esta atención.",
        ),
      );
    return {
      resource_title: await contact(args.contact_id),
      summary: lines.join("\n"),
      resource_url: "/app/agenda",
    };
  }
  if (
    [
      "crm_reschedule_appointment",
      "crm_cancel_appointment",
      "crm_confirm_appointment",
      "crm_set_appointment_outcome",
    ].includes(action.tool_name)
  ) {
    const current = await lookup(
      "calendar_appointments",
      "id",
      args.appointment_id,
      "title,contact_id,starts_at,status,time_zone",
    );
    const statuses: Record<string, string> = {
      pending: text("Aguardando confirmação", "Esperando confirmación"),
      confirmed: text("Confirmado", "Confirmado"),
      cancelled: text("Cancelado", "Cancelado"),
      completed: text("Atendido", "Atendido"),
      no_show: text("Não compareceu", "No asistió"),
    };
    const lines = [
      `${text("Início atual", "Inicio actual")}: ${current?.starts_at ?? unavailable}`,
      `${text("Fuso", "Zona horaria")}: ${current?.time_zone ?? unavailable}`,
      `${text("Situação atual", "Estado actual")}: ${statuses[value(current?.status)] ?? unavailable}`,
    ];
    if (current?.contact_id)
      lines.push(`${text("Cliente", "Cliente")}: ${await contact(current.contact_id)}`);
    lines.push(...fields(["new_starts_at", "notes", "reason"]));
    if (action.tool_name === "crm_set_appointment_outcome") {
      lines.push(
        `${text("Registrar", "Registrar")}: ${
          args.outcome === "completed"
            ? text("A pessoa foi atendida", "La persona fue atendida")
            : text("A pessoa não compareceu", "La persona no asistió")
        }`,
      );
    }
    return {
      resource_title: named(current, "title", args.appointment_id),
      summary: lines.join("\n"),
      resource_url: `/app/agenda?compromisso=${encodeURIComponent(value(args.appointment_id))}`,
    };
  }
  if (action.tool_name === "crm_generate_reply_draft") {
    if (!roleAtLeast(reviewer.role, "agent"))
      return {
        resource_title: unavailable,
        summary: text(
          "Esta operação exige acesso de atendente.",
          "Esta operación requiere acceso de agente de atención.",
        ),
        resource_url: "/app/settings/ai-connections",
      };
    const conversation = await lookup(
      "conversations",
      "id",
      args.conversation_id,
      "contact_id,assigned_to_user_id",
    );
    const access = await conversationAccess({
      supabase: db,
      organizationId,
      role: reviewer.role,
      userId: reviewer.userId,
      connectionId: "approval-review",
    } as McpContext);
    const visible =
      conversation &&
      access &&
      canViewConversation(
        access,
        typeof conversation.assigned_to_user_id === "string"
          ? conversation.assigned_to_user_id
          : null,
      );
    return {
      resource_title: visible
        ? await contact(conversation.contact_id)
        : `${unavailable} (${value(args.conversation_id)})`,
      summary: [
        text(
          "Gerar uma sugestão de resposta com créditos de IA. A mensagem ficará em rascunho para revisão.",
          "Generar una sugerencia de respuesta con créditos de IA. El mensaje quedará como borrador para revisión.",
        ),
        ...fields(["expected_reply_context_revision"]),
      ].join("\n"),
      resource_url: `/app/inbox?id=${encodeURIComponent(value(args.conversation_id))}`,
    };
  }
  return null;
}
