import type { Role } from "@/lib/auth/types";
import { ROLE_RANK } from "@/lib/auth/types";
import type { McpToolDefinition } from "./types";

export const MCP_AREAS = {
  knowledge: "Conhecimento",
  whatsapp: "WhatsApp e atendimento",
  crm: "CRM",
  agenda: "Agenda",
  automations: "Agentes e automações",
  content: "Conteúdo e aquisição",
  management: "Gestão",
  administration: "Administração",
} as const;
export type McpArea = keyof typeof MCP_AREAS;
export type McpOperation = "read" | "write" | "execute";
export const TOOL_AREAS: Record<string, McpArea> = {
  crm_search_contacts: "crm",
  crm_get_contact: "crm",
  crm_propose_contact_field: "crm",
  crm_list_leads: "crm",
  crm_get_lead: "crm",
  crm_create_lead: "crm",
  crm_update_lead: "crm",
  crm_move_lead_stage: "crm",
  crm_list_pipelines: "crm",
  crm_list_contact_orders: "crm",
  crm_search_products: "crm",
  crm_list_conversations: "whatsapp",
  crm_get_conversation: "whatsapp",
  crm_get_conversation_history: "whatsapp",
  crm_send_whatsapp_message: "whatsapp",
  crm_start_conversation_and_send: "whatsapp",
  crm_assign_conversation: "whatsapp",
  crm_manage_tags: "whatsapp",
  crm_get_queue_status: "whatsapp",
  crm_request_human_handoff: "whatsapp",
  crm_list_available_attendants: "whatsapp",
  crm_list_human_cases: "whatsapp",
  crm_get_human_case: "whatsapp",
  crm_add_case_note: "whatsapp",
  crm_close_human_case: "whatsapp",
  crm_resume_ai_attendance: "whatsapp",
  crm_list_event_types: "agenda",
  crm_find_free_slots: "agenda",
  crm_list_appointments: "agenda",
  crm_book_appointment: "agenda",
  crm_find_and_book_appointment: "agenda",
  crm_reschedule_appointment: "agenda",
  crm_cancel_appointment: "agenda",
  crm_confirm_appointment: "agenda",
  crm_set_appointment_outcome: "agenda",
  crm_schedule_followup: "automations",
  crm_cancel_followup: "automations",
  crm_list_followups: "automations",
  crm_list_at_risk_leads: "automations",
  crm_close_demand: "automations",
  crm_propose_reactivation: "automations",
  crm_enroll_followup_flow: "automations",
  crm_list_stages: "automations",
  crm_create_stage: "automations",
  crm_update_stage: "automations",
  crm_archive_stage: "automations",
  crm_list_tags: "automations",
  crm_list_message_templates: "automations",
  crm_render_message_template: "automations",
  crm_list_webhook_sources: "automations",
  crm_list_webhook_source_events: "automations",
  crm_create_webhook_source: "automations",
  crm_set_webhook_source_active: "automations",
  crm_list_automation_rules: "automations",
  crm_list_automation_runs: "automations",
  crm_set_automation_rule_active: "automations",
  crm_list_team_members: "automations",
  crm_search_knowledge: "knowledge",
  crm_list_knowledge_sources: "knowledge",
  crm_list_improvement_proposals: "knowledge",
  crm_get_org_memory: "knowledge",
  crm_save_org_memory: "knowledge",
  crm_list_privacy_requests: "administration",
  crm_describe_external_data: "administration",
  crm_query_external_data: "administration",
};
const EXTERNAL = new Set([
  "crm_send_whatsapp_message",
  "crm_start_conversation_and_send",
  "crm_schedule_followup",
  "crm_enroll_followup_flow",
  "crm_set_automation_rule_active",
  "crm_set_webhook_source_active",
  "crm_resume_ai_attendance",
]);
const DESTRUCTIVE = new Set([
  "crm_archive_stage",
  "crm_cancel_appointment",
  "crm_cancel_followup",
  "crm_close_human_case",
  "crm_close_demand",
]);
export function permissionFor(tool: McpToolDefinition) {
  const area = tool.permission?.area ?? TOOL_AREAS[tool.name];
  if (!area) return null;
  const operation: McpOperation =
    tool.permission?.operation ??
    (EXTERNAL.has(tool.name) ? "execute" : tool.category === "read" ? "read" : "write");
  return {
    area,
    operation,
    scope: `${area}:${operation}`,
    confirmation: tool.permission?.confirmation ?? DESTRUCTIVE.has(tool.name),
  };
}
export const MCP_SCOPES = Object.keys(MCP_AREAS).flatMap((area) =>
  ["read", "write", "execute"].map((op) => `${area}:${op}`),
);
export function validConnectionScopes(scopes: string[], role: Role): boolean {
  return (
    scopes.length > 0 &&
    scopes.every(
      (scope) =>
        MCP_SCOPES.includes(scope) &&
        (scope.endsWith(":read") || ROLE_RANK[role] >= ROLE_RANK.agent) &&
        (!scope.startsWith("administration:") || ROLE_RANK[role] >= ROLE_RANK.admin),
    )
  );
}
export function canCallTool(
  tool: McpToolDefinition,
  auth: { role: Role; scopes: string[]; connectionId?: string },
): boolean {
  if (ROLE_RANK[auth.role] < ROLE_RANK[tool.requiresRole]) return false;
  if (!auth.connectionId)
    return !tool.name.startsWith("knowledge_") && auth.scopes.includes(tool.requiresScope);
  const p = permissionFor(tool);
  return p !== null && auth.scopes.includes(p.scope) && tool.name.startsWith("knowledge_");
}
