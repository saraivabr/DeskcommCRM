import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { buscarConhecimento } from "@/lib/ai/knowledge/busca";
import { pageInput, type KnowledgePage, type PageInput } from "./schema";

export class KnowledgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type KnowledgeContext = {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  requestId: string;
};
export async function listPages(ctx: KnowledgeContext, archived = false, offset = 0) {
  const { data, error } = await ctx.db
    .from("knowledge_pages")
    .select(
      "id,title,parent_id,revision,indexed_revision,archived,source_id,source_url,updated_at,updated_by",
    )
    .eq("organization_id", ctx.organizationId)
    .eq("archived", archived)
    .order("updated_at", { ascending: false })
    .order("id")
    .range(offset, offset + 99);
  if (error)
    throw new KnowledgeError("knowledge_unavailable", "Não foi possível carregar as páginas.", 503);
  return data ?? [];
}
export async function getPage(ctx: KnowledgeContext, id: string): Promise<KnowledgePage> {
  const { data, error } = await ctx.db
    .from("knowledge_pages")
    .select("*")
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error)
    throw new KnowledgeError("knowledge_unavailable", "Não foi possível carregar a página.", 503);
  if (!data) throw new KnowledgeError("not_found", "Página não encontrada.", 404);
  const { data: source, error: sourceError } = await ctx.db
    .from("ai_knowledge_sources")
    .select("last_index_status,last_index_error,last_indexed_at")
    .eq("organization_id", ctx.organizationId)
    .eq("id", data.source_id)
    .maybeSingle();
  if (sourceError)
    throw new KnowledgeError(
      "knowledge_unavailable",
      "Não foi possível consultar a indexação.",
      503,
    );
  return {
    ...data,
    index_status: source?.last_index_status ?? null,
    index_error:
      source?.last_index_status === "failed"
        ? "A indexação falhou. O conteúdo salvo continua disponível."
        : source?.last_index_status === "sem_credencial"
          ? "Cadastre uma credencial de embeddings para habilitar a busca semântica."
          : null,
  } as KnowledgePage;
}
export async function savePage(
  ctx: KnowledgeContext,
  input: PageInput,
  origin: Record<string, string> = {},
) {
  const parsed = pageInput.parse(input);
  const { unified } = await import("unified");
  const { default: remarkParse } = await import("remark-parse");
  const blocks = unified().use(remarkParse).parse(parsed.markdown).children;
  const { data, error } = await ctx.db.rpc("fn_save_knowledge_page", {
    p_org: ctx.organizationId,
    p_actor: ctx.userId,
    p_input: { ...parsed, blocks },
    p_origin: origin,
  });
  if (error) {
    const conflict = error.code === "PT409";
    throw new KnowledgeError(
      conflict ? "revision_conflict" : "save_failed",
      conflict
        ? "Esta página mudou. Copie seu texto e recarregue a versão atual antes de salvar."
        : "Não foi possível salvar a página.",
      conflict ? 409 : 422,
    );
  }
  void audit({
    action: "knowledge.page_saved",
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    resourceType: "knowledge_page",
    resourceId: parsed.id,
    requestId: ctx.requestId,
    metadata: { revision: data.revision, archived: data.archived },
  });
  return data as KnowledgePage;
}
export async function searchPages(ctx: KnowledgeContext, query: string, limit = 10) {
  const { data: lexical, error } = await ctx.db.rpc("fn_search_knowledge_pages", {
    p_org: ctx.organizationId,
    p_query: query,
    p_limit: limit,
  });
  if (error) throw new KnowledgeError("search_failed", "Não foi possível pesquisar.", 503);
  const { data: pages, error: pagesError } = await ctx.db
    .from("knowledge_pages")
    .select("id,title,source_id,revision,indexed_revision,source_url,updated_at")
    .eq("organization_id", ctx.organizationId)
    .eq("archived", false)
    .neq("markdown", "");
  if (pagesError) throw new KnowledgeError("search_failed", "Não foi possível pesquisar.", 503);
  const bySource = new Map(
    (pages ?? []).filter((p) => p.indexed_revision === p.revision).map((p) => [p.source_id, p]),
  );
  const results = new Map<string, Record<string, unknown>>();
  for (const p of lexical ?? [])
    results.set(p.id, { ...p, url: `/app/knowledge?page=${p.id}`, method: "text" });
  let warning: string | null = (pages ?? []).some((p) => p.indexed_revision !== p.revision)
    ? "Há páginas aguardando indexação. Seus textos continuam disponíveis na busca textual."
    : null;
  try {
    const semantic = await buscarConhecimento(ctx.db, {
      organizationId: ctx.organizationId,
      knowledgeSourceIds: [...bySource.keys()],
      pergunta: query,
      topK: limit,
      limiar: 0.4,
    });
    for (const hit of semantic.trechos) {
      const p = hit.knowledge_source_id ? bySource.get(hit.knowledge_source_id) : undefined;
      if (!p) continue;
      results.set(p.id, {
        ...p,
        excerpt: hit.content,
        similarity: hit.similarity,
        url: `/app/knowledge?page=${p.id}`,
        method: "semantic",
        stale: p.revision !== p.indexed_revision,
      });
    }
  } catch {
    warning = "Busca semântica indisponível. Resultados por texto continuam disponíveis.";
  }
  // Recheck visibility after embedding latency: an archived page must never escape.
  const ids = [...results.keys()];
  if (!ids.length) return { results: [], warning };
  const { data: visible, error: visibilityError } = await ctx.db
    .from("knowledge_pages")
    .select("id,revision")
    .eq("organization_id", ctx.organizationId)
    .eq("archived", false)
    .in("id", ids);
  if (visibilityError)
    throw new KnowledgeError("search_failed", "Não foi possível confirmar os resultados.", 503);
  const allowed = new Map((visible ?? []).map((p) => [p.id, p.revision]));
  return {
    results: [...results.values()]
      .filter((p) => allowed.get(p.id as string) === p.revision)
      .slice(0, limit),
    warning,
  };
}
export function newPageInput(title: string, markdown: string): PageInput {
  return {
    id: randomUUID(),
    title,
    markdown,
    expected_revision: 0,
    operation_id: randomUUID(),
    parent_id: null,
    archived: false,
  };
}
