import { z } from "zod";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { generateInstagramPost } from "@/lib/instagram/generate-post";
import { createSchema } from "@/lib/instagram/schema";
import { listItems } from "@/lib/instagram/store";
import type { McpContext, McpToolDefinition } from "../types";

export const contentOperationTools = [
  {
    name: "content_list_studio_posts",
    description:
      "Lista postagens e rascunhos recentes no Estúdio, com estado, legenda e link para revisão. Não publica nada.",
    category: "read",
    requiresRole: "manager",
    requiresScope: "mcp:read",
    permission: { area: "content", operation: "read" },
    inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
    handler: async (input: { limit: number }, ctx: McpContext) => {
      const items = await listItems(ctx.organizationId);
      return {
        posts: items
          .filter((item) => item.kind === "post")
          .slice(0, input.limit)
          .map((item) => ({
            id: item.id,
            status: item.status,
            caption: item.caption,
            image_url: item.image_url ?? null,
            error: item.error,
            url: `/app/instagram/posts/${item.id}`,
          })),
      };
    },
  },
  {
    name: "content_generate_studio_post",
    description:
      "Gera legenda e imagem de uma postagem no Estúdio após confirmação humana. Usa créditos de IA, salva para revisão e não publica no Instagram. Use operation_id UUID estável para evitar geração duplicada.",
    category: "write",
    requiresRole: "manager",
    requiresScope: "mcp:write",
    permission: { area: "content", operation: "execute", confirmation: true },
    inputSchema: {
      operation_id: z.string().uuid(),
      brief: z.string().trim().min(10).max(3000),
      niche: z.string().trim().min(2).max(2000),
      format: z.enum(["feed", "square", "story"]),
      use_logo: z.boolean().default(true),
    },
    redigirParaAuditoria: (args: Record<string, unknown>) => ({ operation_id: args.operation_id }),
    handler: async (
      input: {
        operation_id: string;
        brief: string;
        niche: string;
        format: "feed" | "square" | "story";
        use_logo: boolean;
      },
      ctx: McpContext,
    ) => {
      const org = ctx.organizationId;
      const post = createSchema.parse({
        id: input.operation_id,
        kind: "post",
        brief: input.brief,
        niche: input.niche,
        format: input.format,
        use_logo: input.use_logo,
      });
      if (post.kind !== "post") throw new Error("Formato de postagem inválido.");
      const existing = (await listItems(org, post.id))[0];
      if (existing) {
        if (JSON.stringify(createSchema.parse(existing.input)) !== JSON.stringify(post))
          throw new Error("operation_id já foi usado para outra postagem.");
        return {
          id: existing.id,
          status: existing.status,
          caption: existing.caption,
          image_url: existing.image_url ?? null,
          url: `/app/instagram/posts/${existing.id}`,
        };
      }
      const limit = await checkRateLimit(`instagram:${org}`, 20, 86400);
      if (!limit.allowed) throw new Error("Limite diário de 20 gerações atingido.");
      const db = getRequestPool();
      const inserted = await db.query(
        "insert into instagram_studio_items(id,organization_id,kind,status,input,caption) values($1,$2,'post','generating',$3::jsonb,'') on conflict(id) do nothing returning id",
        [post.id, org, JSON.stringify(post)],
      );
      if (!inserted.rowCount)
        throw new Error("Esta postagem já está em criação. Consulte o Estúdio.");
      void audit({
        action: "instagram.created",
        actorUserId: ctx.userId ?? null,
        organizationId: org,
        resourceType: "instagram_studio_item",
        resourceId: post.id,
        requestId: ctx.requestId,
        metadata: { kind: "post" },
      });
      try {
        await generateInstagramPost(org, post);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Geração interrompida.";
        await db
          .query(
            "update instagram_studio_items set status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2",
            [org, post.id, message],
          )
          .catch(() => undefined);
        void audit({
          action: "instagram.failed",
          actorUserId: ctx.userId ?? null,
          organizationId: org,
          resourceType: "instagram_studio_item",
          resourceId: post.id,
          requestId: ctx.requestId,
        });
        throw new Error("A geração falhou. O pedido foi preservado no Estúdio para revisão.");
      }
      void audit({
        action: "instagram.completed",
        actorUserId: ctx.userId ?? null,
        organizationId: org,
        resourceType: "instagram_studio_item",
        resourceId: post.id,
        requestId: ctx.requestId,
      });
      const result = (await listItems(org, post.id))[0];
      if (!result)
        throw new Error("A postagem foi gerada, mas não pôde ser lida. Confira o Estúdio.");
      return {
        id: result.id,
        status: result.status,
        caption: result.caption,
        image_url: result.image_url ?? null,
        url: `/app/instagram/posts/${result.id}`,
      };
    },
  },
] as unknown as readonly McpToolDefinition[];
