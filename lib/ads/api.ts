import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { sameOriginMutation } from "@/lib/channels/meta/social/oauth";
import { metaPublicOrigin } from "@/lib/channels/meta/social/api";

export async function authorizeAds(request?: Request, mutation = false) {
  const requestId = request?.headers.get("x-request-id") ?? randomUUID();
  if (mutation && (!request || !sameOriginMutation(request, metaPublicOrigin())))
    return {
      ok: false as const,
      response: fail("forbidden", "Esta ação precisa partir da própria aplicação.", 403, {
        requestId,
      }),
    };
  const auth = await requireRole("manager", { requestId, resource: "meta_ads" });
  if (!auth.ok) return auth;
  if (
    mutation &&
    (await authRateLimited("meta_ads_drafts", auth.user.id, { ip: 60, id: 30, windowSec: 300 }))
  )
    return {
      ok: false as const,
      response: fail("rate_limited", "Aguarde alguns minutos antes de continuar.", 429, {
        requestId,
      }),
    };
  return { ...auth, requestId };
}
