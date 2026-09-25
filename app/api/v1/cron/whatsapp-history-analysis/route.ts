import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ok, fail } from "@/lib/api/wrappers";
import { analyzeWhatsappHistory } from "@/lib/channels/whatsapp-history-analysis";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    const result = await analyzeWhatsappHistory();
    if (result.analyzed || result.failures) await audit({
      action: "whatsapp.history_analysis", organizationId: null, requestId,
      metadata: result,
    });
    return ok(result, { requestId });
  } catch {
    return fail("internal_error", "Falha ao analisar o histórico.", 500, { requestId });
  }
}

export const POST = GET;
