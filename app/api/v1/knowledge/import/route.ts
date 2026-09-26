import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { knowledgeRequest } from "@/lib/knowledge/http";
import { newPageInput, savePage, KnowledgeError } from "@/lib/knowledge/service";
import { captureUrl, limitedBody } from "@/lib/knowledge/import";
import { extractPdfText, PdfExtractError } from "@/lib/ai/rag/extractors/pdf";
import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";

export const runtime = "nodejs";
export async function POST(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return knowledgeRequest(true, async (ctx) => {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const bytes = await limitedBody(req, 5000);
      const input = z
        .object({ url: z.string().url().max(2048) })
        .strict()
        .parse(JSON.parse(Buffer.from(bytes).toString()));
      const captured = await captureUrl(input.url);
      return savePage(ctx, newPageInput(captured.title, captured.markdown), {
        source_url: captured.url,
      });
    }
    const bytes = await limitedBody(req, 11_000_000);
    const form = await new Request(req.url, {
      method: "POST",
      headers: { "content-type": req.headers.get("content-type") ?? "" },
      body: Buffer.from(bytes),
    }).formData();
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size > 10_000_000 ||
      !file.name.toLowerCase().endsWith(".pdf")
    )
      throw new KnowledgeError("invalid_file", "Envie um PDF com texto de até 10 MB.", 422);
    const pdf = Buffer.from(await file.arrayBuffer());
    let text: string;
    try {
      text = await extractPdfText(pdf, { estrategia: "processo-a-parte" });
    } catch (error) {
      const noText = error instanceof PdfExtractError && error.motivo === "sem_texto";
      if (!noText && error instanceof Error)
        console.error(
          "[knowledge.pdf]",
          (error.cause instanceof Error ? error.cause.message : error.message).slice(0, 200),
        );
      throw new KnowledgeError(
        noText ? "pdf_without_text" : "pdf_extraction_failed",
        noText
          ? "Este PDF não tem texto selecionável. OCR não está disponível nesta versão."
          : "Não foi possível processar o PDF. Tente novamente ou importe seu texto em uma página.",
        noText ? 422 : 503,
      );
    }
    if (text.length > 200_000)
      throw new KnowledgeError("too_large", "Divida este documento em arquivos menores.", 413);
    const page = newPageInput(file.name.slice(0, 120), text);
    const path = `${ctx.organizationId}/pages/${page.id}/original.pdf`;
    const { error } = await ctx.db.storage
      .from(BUCKET_DE_CONHECIMENTO)
      .upload(path, pdf, { contentType: "application/pdf" });
    if (error)
      throw new KnowledgeError("upload_failed", "Não foi possível guardar o arquivo.", 503);
    try {
      return await savePage(ctx, page, { original_path: path });
    } catch (e) {
      await ctx.db.storage.from(BUCKET_DE_CONHECIMENTO).remove([path]);
      throw e;
    }
  });
}
