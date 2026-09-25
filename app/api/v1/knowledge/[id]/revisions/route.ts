import { z } from "zod";
import { knowledgeRequest } from "@/lib/knowledge/http";
import { getPage, KnowledgeError } from "@/lib/knowledge/service";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return knowledgeRequest(false, async (ctx) => {
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    await getPage(ctx, id);
    const { data, error } = await ctx.db
      .from("knowledge_page_revisions")
      .select("revision,title,markdown,parent_id,archived,actor_id,created_at")
      .eq("organization_id", ctx.organizationId)
      .eq("page_id", id)
      .order("revision", { ascending: false })
      .limit(50);
    if (error)
      throw new KnowledgeError("history_failed", "Não foi possível carregar o histórico.", 503);
    return data;
  });
}
