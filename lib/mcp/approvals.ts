import { createHash } from "node:crypto";
import type { McpContext, McpToolDefinition } from "./types";
import { permissionFor } from "./permissions";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function actionHash(tool: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${tool}:${canonical(args)}`)
    .digest("hex");
}
/** Only a session-authenticated person can change pending to approved. A claim is single use. */
export async function withActionApproval(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  ctx: McpContext,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  if (!ctx.connectionId || !permissionFor(tool)?.confirmation) return execute();
  const hash = actionHash(tool.name, args);
  const now = new Date().toISOString();
  const base = () =>
    ctx.supabase
      .from("mcp_action_approvals")
      .select("id,status,result,expires_at")
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", ctx.connectionId!)
      .eq("tool_name", tool.name)
      .eq("args_hash", hash);
  const { data: existing, error } = await base()
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Não foi possível consultar a confirmação.");
  if (existing?.status === "completed") return existing.result;
  if (existing?.status === "executing" || existing?.status === "failed")
    return {
      status: existing.status,
      approval_id: existing.id,
      message:
        "Esta operação já foi iniciada. Verifique o resultado na interface antes de tentar outra operação.",
    };
  if (existing?.status === "approved" && existing.expires_at > now) {
    const { data: claimed, error: claimError } = await ctx.supabase
      .from("mcp_action_approvals")
      .update({ status: "executing" })
      .eq("id", existing.id)
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", ctx.connectionId)
      .eq("status", "approved")
      .gt("expires_at", now)
      .select("id")
      .maybeSingle();
    if (claimError) throw new Error("Não foi possível reservar a operação.");
    if (!claimed) return { status: "execution_in_progress", approval_id: existing.id };
    try {
      const result = await execute();
      const { error: storeError } = await ctx.supabase
        .from("mcp_action_approvals")
        .update({ status: "completed", result })
        .eq("id", claimed.id)
        .eq("organization_id", ctx.organizationId)
        .eq("connection_id", ctx.connectionId)
        .eq("status", "executing");
      if (storeError)
        throw new Error(
          "A operação foi iniciada, mas não foi possível registrar seu resultado. Confira a interface.",
        );
      return result;
    } catch (e) {
      await ctx.supabase
        .from("mcp_action_approvals")
        .update({ status: "failed" })
        .eq("id", claimed.id)
        .eq("organization_id", ctx.organizationId)
        .eq("connection_id", ctx.connectionId)
        .eq("status", "executing");
      throw e;
    }
  }
  if (existing && existing.expires_at <= now && ["pending", "approved"].includes(existing.status)) {
    const { error: expireError } = await ctx.supabase
      .from("mcp_action_approvals")
      .update({ status: "rejected" })
      .eq("id", existing.id)
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", ctx.connectionId)
      .in("status", ["pending", "approved"]);
    if (expireError) throw new Error("Não foi possível renovar a confirmação.");
  }
  if (existing?.status === "rejected" && existing.expires_at > now)
    return { status: "rejected", approval_id: existing.id };
  let id = existing?.status === "pending" && existing.expires_at > now ? existing.id : null;
  if (!id) {
    const { data: created, error: createError } = await ctx.supabase
      .from("mcp_action_approvals")
      .insert({
        organization_id: ctx.organizationId,
        connection_id: ctx.connectionId,
        user_id: ctx.userId,
        tool_name: tool.name,
        args,
        args_hash: hash,
      })
      .select("id")
      .single();
    if (createError) {
      const { data: concurrent, error: lookupError } = await base()
        .in("status", ["pending", "approved", "executing"])
        .maybeSingle();
      if (lookupError || !concurrent) throw new Error("Não foi possível solicitar confirmação.");
      id = concurrent.id;
    } else id = created.id;
  }
  return {
    status: "confirmation_required",
    approval_id: id,
    url: `/app/settings/ai-connections?approval=${id}`,
    message:
      "Peça ao usuário para revisar esta operação na interface. Após a aprovação, repita os mesmos parâmetros. A IA não pode aprovar.",
  };
}
