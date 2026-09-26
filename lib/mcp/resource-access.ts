import { z } from "zod";
import type { McpContext } from "./types";

export type ConversationAccess = { userId: string; mode: "all" | "own" | "own_and_unassigned" };

/** Mirrors fn_can_view_conversation for user-bound service-role calls. */
export async function conversationAccess(ctx: McpContext): Promise<ConversationAccess | undefined> {
  if (!ctx.connectionId) return undefined;
  const userId = z.string().uuid().parse(ctx.userId);
  if (ctx.role !== "agent") return { userId, mode: "all" };
  const { data, error } = await ctx.supabase
    .from("organizations")
    .select("settings")
    .eq("id", ctx.organizationId)
    .maybeSingle();
  if (error || !data) throw new Error("Não foi possível verificar a visibilidade das conversas.");
  const mode = data.settings?.visibility_mode ?? "own_and_unassigned";
  return { userId, mode: mode === "all" || mode === "own_and_unassigned" ? mode : "own" };
}

export function canViewConversation(
  access: ConversationAccess,
  assignedTo: string | null,
): boolean {
  return (
    access.mode === "all" ||
    assignedTo === access.userId ||
    (access.mode === "own_and_unassigned" && assignedTo === null)
  );
}

export async function requireConversationAccess(ctx: McpContext, conversationId: string) {
  const access = await conversationAccess(ctx);
  if (!access) return;
  const { data, error } = await ctx.supabase
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error || !data || !canViewConversation(access, data.assigned_to_user_id))
    throw new Error("Conversa não encontrada ou sem acesso.");
}
