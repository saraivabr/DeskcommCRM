import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { knowledgeRequest } from "@/lib/knowledge/http";
import { getPage, KnowledgeError } from "@/lib/knowledge/service";

export async function GET() {
  return knowledgeRequest(false, async (ctx) => {
    const { data, error } = await ctx.db
      .from("knowledge_page_favorites")
      .select("page_id")
      .eq("organization_id", ctx.organizationId)
      .eq("user_id", ctx.userId);
    if (error)
      throw new KnowledgeError("favorites_failed", "Não foi possível carregar favoritos.", 503);
    return data;
  });
}
export async function POST(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return knowledgeRequest(false, async (ctx) => {
    const input = z
      .object({ page_id: z.string().uuid(), favorite: z.boolean() })
      .strict()
      .parse(await req.json());
    await getPage(ctx, input.page_id);
    const result = input.favorite
      ? await ctx.db
          .from("knowledge_page_favorites")
          .upsert({
            organization_id: ctx.organizationId,
            user_id: ctx.userId,
            page_id: input.page_id,
          })
      : await ctx.db
          .from("knowledge_page_favorites")
          .delete()
          .eq("organization_id", ctx.organizationId)
          .eq("user_id", ctx.userId)
          .eq("page_id", input.page_id);
    if (result.error)
      throw new KnowledgeError("favorites_failed", "Não foi possível atualizar o favorito.", 503);
    return { favorite: input.favorite };
  });
}
