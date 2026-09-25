import { z } from "zod";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { knowledgeRequest } from "@/lib/knowledge/http";
import { pageInput } from "@/lib/knowledge/schema";
import { listPages, savePage } from "@/lib/knowledge/service";

export async function GET(req: Request) {
  return knowledgeRequest(false, async (ctx) => {
    const q = z
      .object({
        archived: z.enum(["true", "false"]).default("false"),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(Object.fromEntries(new URL(req.url).searchParams));
    return listPages(ctx, q.archived === "true", q.offset);
  });
}
export async function POST(req: Request) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  return knowledgeRequest(true, async (ctx) => savePage(ctx, pageInput.parse(await req.json())));
}
