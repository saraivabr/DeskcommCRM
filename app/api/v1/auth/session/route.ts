import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";
import { getUserWithDeadline, isAuthUnavailable } from "@/lib/auth/availability";

export const dynamic = "force-dynamic";

/** Renova pelo cookie HttpOnly no servidor; nenhum token vai para o browser. */
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  const headers = { "cache-control": "no-store, max-age=0" };
  const unavailable = () => fail("auth_unavailable", "A verificação de acesso está temporariamente indisponível. Tente novamente.", 503, { requestId, headers: { ...headers, "Retry-After": "2" } });
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await getUserWithDeadline(() => supabase.auth.getUser());
    if (isAuthUnavailable(error)) return unavailable();
    if (error || !user) return fail("unauthenticated", "Entre novamente para continuar.", 401, { requestId, headers });
    return ok({ authenticated: true }, { requestId, headers });
  } catch {
    return unavailable();
  }
}
