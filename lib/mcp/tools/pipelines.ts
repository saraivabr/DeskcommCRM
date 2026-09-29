/**
 * MCP read tool — crm_list_pipelines (Spec 11 §3.1).
 */
import { z } from "zod";

import { listPipelinesHandler } from "@/app/api/v1/pipelines/_handler";
import type { McpToolDefinition } from "../types";

const listInputShape = {
  include_archived: z.boolean().optional().default(false),
};

export const crmListPipelines: McpToolDefinition<typeof listInputShape> = {
  name: "crm_list_pipelines",
  description:
    "Lista funis do CRM e seu vocabulário. Use crm_list_stages com pipeline_id para consultar as etapas antes de criar ou mover uma oportunidade.",
  inputSchema: listInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    const result = await listPipelinesHandler(
      ctx.supabase,
      {
        organization_id: ctx.organizationId,
        actor: ctx.actor,
        requestId: ctx.requestId,
      },
      { include_archived: input.include_archived },
    );
    const onlyOrg = result.pipelines.filter((p) => p.organization_id === ctx.organizationId);
    return {
      pipelines: onlyOrg.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        is_default: p.is_default,
        is_archived: p.is_archived,
        position: p.position,
        vocabulary: p.vocabulary,
      })),
    };
  },
};
