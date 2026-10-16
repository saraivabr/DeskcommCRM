import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { fail, ok } from "@/lib/api/wrappers";
import { homeInputSchema, loadHomeOverview } from "@/lib/workspace/home";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = homeInputSchema.safeParse({
    ...params,
    ...(params.days === undefined ? {} : { days: Number(params.days) }),
  });
  if (!parsed.success)
    return fail("invalid_request", "Escolha um período e um escopo válidos.", 400, { requestId });

  // O relógio começa antes da autorização, que tem seus próprios prazos.
  // Se ela atrasar, nenhuma leitura da Home começa depois deste limite.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
  const auth = await requireRole(parsed.data.scope === "team" ? "manager" : "viewer", {
    requestId,
    resource: "workspace_home",
  });
  if (!auth.ok) return auth.response;

  try {
    signal.throwIfAborted();
    const data = await loadHomeOverview(
      await createClient(),
      auth.org.orgId,
      auth.user.id,
      auth.org.role,
      parsed.data,
      undefined,
      signal,
    );
    return ok(data, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail(
      "service_unavailable",
      "Não foi possível carregar sua operação. Tente atualizar novamente.",
      503,
      { requestId, headers: { "Cache-Control": "no-store" } },
    );
  }
}
