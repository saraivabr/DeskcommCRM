import { describe, it, expect } from "vitest";
import { canCallTool, permissionFor, validConnectionScopes } from "@/lib/mcp/permissions";
import type { McpToolDefinition } from "@/lib/mcp/types";
import { getToolByName } from "@/lib/mcp/tools";
const save = {
  name: "knowledge_save_page",
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  permission: { area: "knowledge", operation: "write" },
} as McpToolDefinition;
const read = {
  ...save,
  name: "knowledge_read_page",
  category: "read",
  requiresRole: "viewer",
  requiresScope: "mcp:read",
  permission: { area: "knowledge", operation: "read" },
} as McpToolDefinition;
describe("connection permissions", () => {
  it.each([
    ["crm_create_lead", "crm:write"],
    ["crm_update_lead", "crm:write"],
    ["crm_move_lead_stage", "crm:write"],
    ["crm_schedule_followup", "automations:execute"],
    ["crm_cancel_followup", "automations:execute"],
    ["crm_book_appointment", "agenda:write"],
    ["crm_find_and_book_appointment", "agenda:write"],
    ["crm_reschedule_appointment", "agenda:write"],
    ["crm_cancel_appointment", "agenda:write"],
    ["crm_confirm_appointment", "agenda:write"],
    ["crm_set_appointment_outcome", "agenda:write"],
  ])("%s requires personal management access, its scope and confirmation", (name, scope) => {
    const tool = getToolByName(name)!;
    expect(tool).toBeDefined();
    const personal = { connectionId: "test", role: "manager" as const };
    expect(canCallTool(tool, { ...personal, scopes: [scope] })).toBe(true);
    expect(canCallTool(tool, { ...personal, scopes: [] })).toBe(false);
    expect(canCallTool(tool, { ...personal, role: "agent", scopes: [scope] })).toBe(false);
    expect(permissionFor(tool)).toMatchObject({ scope, confirmation: true });
    // Existing published-agent roles/scopes remain valid.
    expect(canCallTool(tool, { role: "ai_operator", scopes: [tool.requiresScope] })).toBe(true);
  });
  it.each([
    ["crm_list_stages", "crm:read"],
    ["crm_list_followups", "automations:read"],
    ["crm_list_at_risk_leads", "automations:read"],
    ["crm_list_event_types", "agenda:read"],
    ["crm_find_free_slots", "agenda:read"],
    ["crm_list_appointments", "agenda:read"],
  ])("%s does not expose team-wide reads to an agent connection", (name, scope) => {
    const tool = getToolByName(name)!;
    expect(tool).toBeDefined();
    expect(canCallTool(tool, { connectionId: "test", role: "manager", scopes: [scope] })).toBe(
      true,
    );
    expect(canCallTool(tool, { connectionId: "test", role: "agent", scopes: [scope] })).toBe(false);
    expect(canCallTool(tool, { role: "ai_operator", scopes: ["mcp:read"] })).toBe(true);
  });
  it.each([
    ["crm_get_attendance_context", "whatsapp:read"],
    ["crm_generate_reply_draft", "whatsapp:execute"],
  ])("%s belongs to a personal connection, never a legacy agent token", (name, scope) => {
    const tool = getToolByName(name)!;
    expect(tool).toBeDefined();
    expect(canCallTool(tool, { connectionId: "test", role: "agent", scopes: [scope] })).toBe(true);
    expect(canCallTool(tool, { role: "ai_operator", scopes: ["mcp:read", "mcp:write"] })).toBe(
      false,
    );
    expect(canCallTool(tool, { connectionId: "test", role: "viewer", scopes: [scope] })).toBe(
      false,
    );
  });
  it("read grants cannot write and membership downgrade removes write", () => {
    expect(
      canCallTool(read, { connectionId: "test", role: "agent", scopes: ["knowledge:read"] }),
    ).toBe(true);
    expect(
      canCallTool(save, { connectionId: "test", role: "agent", scopes: ["knowledge:read"] }),
    ).toBe(false);
    expect(
      canCallTool(save, { connectionId: "test", role: "viewer", scopes: ["knowledge:write"] }),
    ).toBe(false);
  });
  it("rejects role metadata and elevated scopes as a grant", () => {
    expect(validConnectionScopes(["knowledge:read", "role:admin"], "agent")).toBe(false);
    expect(validConnectionScopes(["knowledge:write"], "viewer")).toBe(false);
    expect(validConnectionScopes(["administration:write"], "agent")).toBe(false);
  });
  it("keeps WhatsApp sending separate from CRM edits", () => {
    const tool = {
      name: "crm_send_whatsapp_message",
      category: "write",
      requiresRole: "agent",
      requiresScope: "mcp:write",
    } as McpToolDefinition;
    expect(permissionFor(tool)?.scope).toBe("whatsapp:execute");
    expect(canCallTool(tool, { connectionId: "test", role: "admin", scopes: ["crm:write"] })).toBe(
      false,
    );
    expect(canCallTool(tool, { role: "agent", scopes: ["mcp:write"] })).toBe(true);
  });
  it("does not expose shared knowledge to legacy agent tokens implicitly", () => {
    expect(canCallTool(read, { role: "agent", scopes: ["mcp:read"] })).toBe(false);
  });
  it("separates agent drafts, publication and paid post generation by scope and role", () => {
    const draft = {
      name: "ai_create_agent_draft",
      category: "write",
      requiresRole: "admin",
      requiresScope: "mcp:write",
      permission: { area: "automations", operation: "write" },
    } as McpToolDefinition;
    const publish = {
      ...draft,
      name: "ai_publish_agent_draft",
      permission: { area: "automations", operation: "execute", confirmation: true },
    } as McpToolDefinition;
    const generate = {
      ...draft,
      name: "content_generate_studio_post",
      requiresRole: "manager",
      permission: { area: "content", operation: "execute", confirmation: true },
    } as McpToolDefinition;
    const auth = { connectionId: "test", role: "admin" as const };
    expect(canCallTool(draft, { ...auth, scopes: ["automations:read"] })).toBe(false);
    expect(canCallTool(draft, { ...auth, scopes: ["automations:write"] })).toBe(true);
    expect(canCallTool(draft, { role: "admin", scopes: ["mcp:write"] })).toBe(false);
    expect(canCallTool(publish, { ...auth, scopes: ["automations:write"] })).toBe(false);
    expect(canCallTool(publish, { ...auth, scopes: ["automations:execute"] })).toBe(true);
    expect(canCallTool(generate, { ...auth, scopes: ["content:read"] })).toBe(false);
    expect(canCallTool(generate, { ...auth, scopes: ["content:execute"] })).toBe(true);
    expect(canCallTool(generate, { role: "admin", scopes: ["mcp:write"] })).toBe(false);
    expect(
      canCallTool(generate, { connectionId: "test", role: "agent", scopes: ["content:execute"] }),
    ).toBe(false);
  });
});
