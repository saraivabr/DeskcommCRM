import { z } from "zod";
import { knowledgeRequest } from "@/lib/knowledge/http";
import { searchPages } from "@/lib/knowledge/service";

export async function GET(req: Request) {
  return knowledgeRequest(false, async (ctx) =>
    searchPages(
      ctx,
      z.string().trim().min(1).max(500).parse(new URL(req.url).searchParams.get("q")),
    ),
  );
}
