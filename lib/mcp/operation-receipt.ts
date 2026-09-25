import { actionHash } from "./approvals";
import type { McpContext } from "./types";

/** No automatic takeover: a timeout cannot establish whether the provider sent a message. */
export async function withOperationReceipt(
  ctx: McpContext,
  toolName: string,
  key: string,
  args: Record<string, unknown>,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  if (!ctx.connectionId) throw new Error("Uma conexão pessoal é necessária.");
  const hash = actionHash(toolName, args);
  const base = () =>
    ctx.supabase
      .from("mcp_operation_receipts")
      .select("id,request_hash,status,result")
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", ctx.connectionId!)
      .eq("tool_name", toolName)
      .eq("operation_key", key);
  const { data: claim, error } = await ctx.supabase
    .from("mcp_operation_receipts")
    .insert({
      organization_id: ctx.organizationId,
      connection_id: ctx.connectionId,
      tool_name: toolName,
      operation_key: key,
      request_hash: hash,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code !== "23505")
      throw new Error(
        "Não foi possível reservar a operação. Nenhum envio foi iniciado por esta chamada.",
      );
    const { data: existing, error: readError } = await base().single();
    if (readError || !existing)
      throw new Error(
        "Não foi possível consultar a operação anterior. Não troque a chave; consulte a conversa.",
      );
    if (existing.request_hash !== hash)
      throw new Error("Esta chave já pertence a parâmetros diferentes.");
    if (existing.status === "completed") return existing.result;
    return {
      operation_id: existing.id,
      status: existing.status,
      message:
        "O envio pode estar em andamento ou ter terminado sem recibo. Consulte a conversa antes de tentar outra operação; não troque a chave automaticamente.",
    };
  }
  try {
    const result = await execute();
    const receipt = { ...(result as Record<string, unknown>), operation_id: claim.id };
    const saved = await ctx.supabase
      .from("mcp_operation_receipts")
      .update({ status: "completed", result: receipt, completed_at: new Date().toISOString() })
      .eq("id", claim.id)
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", ctx.connectionId)
      .eq("status", "executing")
      .select("id")
      .single();
    if (saved.error)
      throw new Error(
        "O envio foi iniciado, mas seu recibo não pôde ser salvo. Consulte a conversa; não repita com outra chave.",
      );
    return receipt;
  } catch (error) {
    await ctx.supabase
      .from("mcp_operation_receipts")
      .update({ status: "uncertain" })
      .eq("id", claim.id)
      .eq("organization_id", ctx.organizationId)
      .eq("connection_id", ctx.connectionId)
      .eq("status", "executing");
    throw error;
  }
}
