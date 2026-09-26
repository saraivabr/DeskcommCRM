import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { getToolByName } from "@/lib/mcp/tools";
import { catalogEntry, deModuloDesligado } from "@/lib/mcp/tools/catalog";
import { canCallTool } from "@/lib/mcp/permissions";
import { resolveConnection } from "@/lib/mcp/connections";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { audit } from "@/lib/audit";
export async function GET() {
  const auth = await requireRole("viewer", { resource: "mcp_action_approvals" });
  if (!auth.ok) return auth.response;
  if (auth.user.support) return fail("forbidden", "Saia do modo de suporte.", 403);
  const db = createAdminClient();
  const { data, error } = await db
    .from("mcp_action_approvals")
    .select("id,tool_name,args,created_at,expires_at,status,connection_id")
    .eq("organization_id", auth.org.orgId)
    .eq("user_id", auth.user.id)
    .in("status", ["pending", "approved", "executing", "failed"])
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return fail("internal_error", "Não foi possível consultar confirmações.", 500);
  const approvals = await Promise.all(
    (data ?? []).map(async (row) => {
      const { data: page } = await db
        .from("knowledge_pages")
        .select("title")
        .eq("organization_id", auth.org.orgId)
        .eq("id", row.args.id)
        .maybeSingle();
      return {
        ...row,
        label: catalogEntry(row.tool_name)?.rotulo ?? row.tool_name,
        resource_title: page?.title ?? "Página indisponível",
      };
    }),
  );
  return ok({ approvals });
}
export async function POST(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireRole("viewer", { resource: "mcp_action_approvals" });
  if (!auth.ok) return auth.response;
  if (auth.user.support || req.headers.get("origin") !== new URL(req.url).origin)
    return fail("forbidden", "A confirmação exige sua sessão na interface.", 403);
  const parsed = z
    .object({ id: z.string().uuid(), approve: z.boolean() })
    .strict()
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("invalid_request", "Confirmação inválida.", 422);
  const db = createAdminClient();
  const { data: action, error } = await db
    .from("mcp_action_approvals")
    .select("id,connection_id,tool_name")
    .eq("id", parsed.data.id)
    .eq("organization_id", auth.org.orgId)
    .eq("user_id", auth.user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !action) return fail("not_found", "Esta confirmação não está mais pendente.", 404);
  if (parsed.data.approve) {
    const { data: token, error: tokenError } = await db
      .from("api_tokens")
      .select("scopes,revoked_at,expires_at")
      .eq("id", action.connection_id)
      .eq("organization_id", auth.org.orgId)
      .maybeSingle();
    if (
      tokenError ||
      !token ||
      token.revoked_at ||
      (token.expires_at && Date.parse(token.expires_at) <= Date.now())
    )
      return fail("forbidden", "A conexão expirou ou foi revogada.", 403);
    const scopes = Array.isArray(token.scopes)
      ? token.scopes.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const granted = scopes.find((s) => s.startsWith("role:"))?.slice(5) as Role | undefined;
    if (!granted || !(granted in ROLE_RANK)) return fail("forbidden", "Conexão inválida.", 403);
    try {
      const live = await resolveConnection(action.connection_id, auth.org.orgId, granted);
      const tool = getToolByName(action.tool_name);
      if (
        live.userId !== auth.user.id ||
        !tool ||
        !canCallTool(tool, { role: live.role, connectionId: live.connectionId, scopes }) ||
        deModuloDesligado(tool.name, await modulosLigados(db))
      )
        return fail("forbidden", "A conexão não tem mais permissão para esta operação.", 403);
    } catch {
      return fail("forbidden", "Conexão revogada ou sem acesso.", 403);
    }
  }
  const { data: updated, error: updateError } = await db
    .from("mcp_action_approvals")
    .update({ status: parsed.data.approve ? "approved" : "rejected" })
    .eq("id", action.id)
    .eq("organization_id", auth.org.orgId)
    .eq("user_id", auth.user.id)
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .select("id,status")
    .maybeSingle();
  if (updateError || !updated)
    return fail("conflict", "A confirmação mudou. Recarregue a página.", 409);
  await audit({
    action: "mcp.action_approved",
    actorUserId: auth.user.id,
    organizationId: auth.org.orgId,
    resourceType: "mcp_action_approval",
    resourceId: action.id,
    metadata: { approved: parsed.data.approve, tool: action.tool_name },
  });
  return ok(updated);
}
