import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
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
  } catch (error) {
    // Registre apenas a classe e os campos inválidos; a resposta do modelo
    // pode conter dados de conversas e nunca deve ir para logs ou HTTP.
    console.error("whatsapp_history_playbook_failed", {
      kind: error instanceof Error ? error.name : "unknown",
      code: error instanceof Error && /^history_playbook_[a-z_]+$/.test(error.message)
        ? error.message : null,
      fields: error instanceof ZodError ? error.issues.map((issue) => issue.path.join(".")) : [],
      dbCode: typeof error === "object" && error !== null && "code" in error &&
        typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : null,
    });
    return fail("internal_error", "Falha ao preparar o playbook do histórico.", 500, { requestId });
  }
}

export const POST = GET;
