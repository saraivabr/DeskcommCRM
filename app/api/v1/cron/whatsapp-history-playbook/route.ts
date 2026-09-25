import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ok, fail } from "@/lib/api/wrappers";
import { generateWhatsappHistoryPlaybook } from "@/lib/channels/whatsapp-history-playbook";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    return ok(await generateWhatsappHistoryPlaybook(), { requestId });
  } catch {
    return fail("internal_error", "Falha ao preparar o playbook do histórico.", 500, { requestId });
  }
}

export const POST = GET;
