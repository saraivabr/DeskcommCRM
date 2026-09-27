import { z } from "zod";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { audit } from "@/lib/audit";
import { VALID_TOOL_IDS } from "./catalog";
import type { McpContext, McpToolDefinition } from "../types";

const versionFields = [
  "system_prompt",
  "provider",
  "model",
  "credential_id",
  "tool_ids",
  "trigger_config",
  "channel_session_id",
  "max_steps",
  "token_budget",
  "cost_budget_cents",
  "history_message_window",
  "history_token_window",
  "handoff_keywords",
  "handoff_tool_enabled",
  "cases_enabled",
  "split_messages",
  "split_max_chars",
  "followup",
  "operator_enabled",
  "operator_model",
  "operator_tool_ids",
  "pipeline_ids",
  "knowledge_source_ids",
] as const;

async function agentInOrg(ctx: McpContext, id: string) {
  const { data, error } = await ctx.supabase
    .from("ai_agents")
    .select("id,name,description,kind,operation_mode,paused_at,published_version_id,archived_at")
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error("Não foi possível consultar o agente.");
  if (!data || data.archived_at) throw new Error("Agente não encontrado nesta organização.");
  return data;
}

export const aiOperationTools = [
  {
    name: "ai_list_agents",
    description:
      "Lista os agentes da organização, estado operacional e versão publicada. Não altera nada.",
    category: "read",
    requiresRole: "manager",
    requiresScope: "mcp:read",
    permission: { area: "automations", operation: "read" },
    inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    handler: async (input: { limit: number }, ctx: McpContext) => {
      const { data, error } = await ctx.supabase
        .from("ai_agents")
        .select("id,name,description,kind,operation_mode,paused_at,published_version_id,created_at")
        .eq("organization_id", ctx.organizationId)
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(input.limit);
      if (error) throw new Error("Não foi possível listar os agentes.");
      return { agents: data ?? [] };
    },
  },
  {
    name: "ai_get_agent_configuration",
    description:
      "Lê configuração publicada e rascunhos de um agente, incluindo instruções e capacidades; não retorna credenciais.",
    category: "read",
    requiresRole: "manager",
    requiresScope: "mcp:read",
    permission: { area: "automations", operation: "read" },
    inputSchema: { agent_id: z.string().uuid() },
    handler: async (input: { agent_id: string }, ctx: McpContext) => {
      const agent = await agentInOrg(ctx, input.agent_id);
      const { data, error } = await ctx.supabase
        .from("ai_agent_versions")
        .select(
          "id,version_number,status,system_prompt,provider,model,tool_ids,trigger_config,created_at,published_at",
        )
        .eq("organization_id", ctx.organizationId)
        .eq("agent_id", input.agent_id)
        .in("status", ["draft", "published"])
        .order("version_number", { ascending: false })
        .limit(10);
      if (error) throw new Error("Não foi possível ler as versões do agente.");
      return { agent, versions: data ?? [] };
    },
  },
  {
    name: "ai_create_agent_draft",
    description:
      "Cria rascunho de nova versão de agente a partir da versão publicada, mudando instruções e opcionalmente capacidades. Não ativa nem publica o rascunho. Use operation_id UUID estável para repetir a mesma tentativa.",
    category: "write",
    requiresRole: "admin",
    requiresScope: "mcp:write",
    permission: { area: "automations", operation: "write" },
    inputSchema: {
      agent_id: z.string().uuid(),
      operation_id: z.string().uuid(),
      system_prompt: z.string().trim().min(20).max(30000),
      tool_ids: z.array(z.string()).max(25).optional(),
    },
    redigirParaAuditoria: (args: Record<string, unknown>) => ({
      agent_id: args.agent_id,
      operation_id: args.operation_id,
    }),
    handler: async (
      input: { agent_id: string; operation_id: string; system_prompt: string; tool_ids?: string[] },
      ctx: McpContext,
    ) => {
      if (!ctx.userId) throw new Error("Conexão pessoal necessária.");
      const agent = await agentInOrg(ctx, input.agent_id);
      if (!agent.published_version_id)
        throw new Error(
          "Este agente ainda não tem versão publicada. Configure-o no editor primeiro.",
        );
      const { data: prior } = await ctx.supabase
        .from("ai_agent_versions")
        .select("id,agent_id,system_prompt,tool_ids,status")
        .eq("organization_id", ctx.organizationId)
        .eq("id", input.operation_id)
        .maybeSingle();
      if (prior) {
        if (
          prior.agent_id !== input.agent_id ||
          prior.system_prompt !== input.system_prompt ||
          JSON.stringify(prior.tool_ids) !== JSON.stringify(input.tool_ids ?? prior.tool_ids)
        )
          throw new Error("operation_id já foi usado com outra configuração.");
        return { id: prior.id, status: prior.status, url: `/app/ai/agents/${input.agent_id}` };
      }
      if (input.tool_ids?.some((id) => !VALID_TOOL_IDS.includes(id)))
        throw new Error("Uma capacidade solicitada não existe no catálogo.");
      const { data: source, error: sourceError } = await ctx.supabase
        .from("ai_agent_versions")
        .select("*")
        .eq("organization_id", ctx.organizationId)
        .eq("agent_id", input.agent_id)
        .eq("id", agent.published_version_id)
        .single();
      if (sourceError || !source) throw new Error("Não foi possível ler a versão publicada.");
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: latest } = await ctx.supabase
          .from("ai_agent_versions")
          .select("version_number")
          .eq("organization_id", ctx.organizationId)
          .eq("agent_id", input.agent_id)
          .order("version_number", { ascending: false })
          .limit(1)
          .maybeSingle();
        const { data, error } = await ctx.supabase
          .from("ai_agent_versions")
          .insert({
            ...Object.fromEntries(versionFields.map((field) => [field, source[field]])),
            id: input.operation_id,
            organization_id: ctx.organizationId,
            agent_id: input.agent_id,
            version_number: (latest?.version_number ?? 0) + 1,
            system_prompt: input.system_prompt,
            tool_ids: input.tool_ids ?? source.tool_ids,
            status: "draft",
            created_by: ctx.userId,
          })
          .select("id,version_number,status")
          .single();
        if (!error && data) {
          void audit({
            action: "ai_agent.version_created",
            actorUserId: ctx.userId,
            organizationId: ctx.organizationId,
            resourceType: "ai_agent_version",
            resourceId: data.id,
            requestId: ctx.requestId,
            metadata: { agent_id: input.agent_id, version_number: data.version_number },
          });
          return { ...data, url: `/app/ai/agents/${input.agent_id}` };
        }
        if (error?.code === "23505") {
          const { data: duplicate } = await ctx.supabase
            .from("ai_agent_versions")
            .select("id,agent_id,system_prompt,tool_ids,status,version_number")
            .eq("organization_id", ctx.organizationId)
            .eq("id", input.operation_id)
            .maybeSingle();
          if (duplicate) {
            if (
              duplicate.agent_id !== input.agent_id ||
              duplicate.system_prompt !== input.system_prompt ||
              JSON.stringify(duplicate.tool_ids) !==
                JSON.stringify(input.tool_ids ?? source.tool_ids)
            )
              throw new Error("operation_id já foi usado com outra configuração.");
            return {
              id: duplicate.id,
              version_number: duplicate.version_number,
              status: duplicate.status,
              url: `/app/ai/agents/${input.agent_id}`,
            };
          }
          continue;
        }
        throw new Error("Não foi possível criar o rascunho do agente.");
      }
      throw new Error("Conflito de versionamento. Tente novamente com o mesmo operation_id.");
    },
  },
  {
    name: "ai_publish_agent_draft",
    description:
      "Publica uma versão em rascunho após confirmação humana no escreve.ai. A versão passa a responder clientes; primeiro mostre as diferenças para o usuário.",
    category: "write",
    requiresRole: "admin",
    requiresScope: "mcp:write",
    permission: { area: "automations", operation: "execute", confirmation: true },
    inputSchema: { agent_id: z.string().uuid(), version_id: z.string().uuid() },
    handler: async (input: { agent_id: string; version_id: string }, ctx: McpContext) => {
      await agentInOrg(ctx, input.agent_id);
      const { data: target } = await ctx.supabase
        .from("ai_agent_versions")
        .select("id,status,tool_ids")
        .eq("organization_id", ctx.organizationId)
        .eq("agent_id", input.agent_id)
        .eq("id", input.version_id)
        .maybeSingle();
      if (!target || target.status !== "draft") throw new Error("Rascunho indisponível.");
      if ((target.tool_ids ?? []).some((id: string) => !VALID_TOOL_IDS.includes(id)))
        throw new Error("O rascunho contém capacidade inexistente.");
      const result = await publishAgentVersion(ctx.supabase, {
        orgId: ctx.organizationId,
        agentId: input.agent_id,
        versionId: input.version_id,
      });
      if (!result.ok) throw new Error(`Não foi possível publicar: ${result.code}.`);
      void ctx.supabase
        .from("event_log")
        .insert({
          organization_id: ctx.organizationId,
          event_type: "ai_agent.published",
          entity_kind: "ai_agent",
          payload: {
            agent_id: result.agent_id,
            version_id: result.version_id,
            previous_version_id: result.previous_version_id,
            published_at: result.published_at,
          },
        })
        .then(({ error }) => {
          if (error) console.error("[mcp.ai_publish_agent_draft] event_log error", error.message);
        });
      void audit({
        action: "ai_agent.published",
        actorUserId: ctx.userId ?? null,
        organizationId: ctx.organizationId,
        resourceType: "ai_agent",
        resourceId: input.agent_id,
        requestId: ctx.requestId,
        metadata: {
          version_id: result.version_id,
          previous_version_id: result.previous_version_id,
        },
      });
      return {
        status: "published",
        agent_id: input.agent_id,
        version_id: input.version_id,
        url: `/app/ai/agents/${input.agent_id}`,
      };
    },
  },
] as unknown as readonly McpToolDefinition[];
