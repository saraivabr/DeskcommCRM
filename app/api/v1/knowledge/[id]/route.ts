import { z } from "zod";
import { knowledgeRequest } from "@/lib/knowledge/http";
import { getPage } from "@/lib/knowledge/service";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return knowledgeRequest(false, async (ctx) =>
    getPage(
      ctx,
      z
        .string()
        .uuid()
        .parse((await params).id),
    ),
  );
}
