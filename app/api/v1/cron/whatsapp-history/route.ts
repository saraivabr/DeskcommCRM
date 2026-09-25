import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { ok, fail } from "@/lib/api/wrappers";
import { syncWhatsappHistory } from "@/lib/channels/whatsapp-history";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    const result = await syncWhatsappHistory();
    if (result.messages > 0 || result.failures > 0) await audit({
      action: "whatsapp.history_sync", organizationId: null, requestId,
      metadata: { sessions: result.sessions, messages: result.messages, failures: result.failures },
    });
    return ok(result, { requestId });
  } catch {
    return fail("internal_error", "Falha ao sincronizar histórico.", 500, { requestId });
  }
}

export const POST = GET;
