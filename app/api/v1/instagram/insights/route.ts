import { LEGACY_INSTAGRAM_PUBLICATION_PROVIDER } from "@/lib/channels/social/instagram-publishing";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { instagramInsights } from "@/lib/channels/social/instagram-insights";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { instagramReadAccounts } from "@/lib/instagram/accounts";
import { instagramAPIError } from "@/lib/instagram/api-error";
import { nativeInstagramInsights } from "@/lib/channels/meta/social/instagram-read";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  const parsed = z
    .discriminatedUnion("provider", [
      z
        .object({ provider: z.literal("meta"), account_id: z.uuid(), connection_id: z.uuid() })
        .strict(),
      z
        .object({
          provider: z.literal(LEGACY_INSTAGRAM_PUBLICATION_PROVIDER),
          account_id: z
            .string()
            .regex(/^[a-f0-9]{24}$/)
            .optional(),
        })
        .strict(),
    ])
    .safeParse({
      provider: LEGACY_INSTAGRAM_PUBLICATION_PROVIDER,
      ...Object.fromEntries(new URL(req.url).searchParams),
    });
  if (!parsed.success)
    return fail("invalid_request", "Selecione uma conta válida.", 400, { requestId });
  const limit = await checkRateLimit(`instagram-insights:${auth.org.orgId}`, 20, 60);
  if (!limit.allowed)
    return fail("rate_limited", "Aguarde um minuto para atualizar os resultados.", 429, {
      requestId,
    });
  try {
    const selection = parsed.data;
    const result = !selection.account_id
      ? await instagramReadAccounts(auth.org.orgId, req.signal).then(
          ({ accounts, provider_errors }) => ({
            connected: accounts.some((a) => a.active),
            accounts,
            provider_errors,
          }),
        )
      : selection.provider === "meta"
        ? {
            insights: await nativeInstagramInsights(auth.org.orgId, selection, req.signal),
            checked_at: new Date().toISOString(),
          }
        : await instagramInsights(auth.org.orgId, selection.account_id);
    return ok(result, {
      requestId,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return instagramAPIError(error, requestId);
  }
}
