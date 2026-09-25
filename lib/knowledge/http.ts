import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail, ok } from "@/lib/api/wrappers";
import { KnowledgeError, type KnowledgeContext } from "./service";

export async function knowledgeRequest(
  write: boolean,
  run: (ctx: KnowledgeContext) => Promise<unknown>,
) {
  const requestId = randomUUID();
  if (write) {
    const denied = await requireSupportWrite();
    if (denied) return denied;
  }
  const auth = await requireRole(write ? "agent" : "viewer", {
    requestId,
    resource: "knowledge_pages",
  });
  if (!auth.ok) return auth.response;
  try {
    return ok(
      await run({
        db: createAdminClient(),
        organizationId: auth.org.orgId,
        userId: auth.user.id,
        requestId,
      }),
      { requestId },
    );
  } catch (e) {
    if (e instanceof ZodError || e instanceof SyntaxError)
      return fail("validation_failed", "Dados inválidos.", 422, { requestId });
    if (e instanceof KnowledgeError) return fail(e.code, e.message, e.status, { requestId });
    return fail("internal_error", "Não foi possível concluir. Tente novamente.", 500, {
      requestId,
    });
  }
}
