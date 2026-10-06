import { z } from "zod";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { env } from "@/lib/env";
import { authenticatedSessionId } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { sameOriginMutation } from "./oauth";
import { MetaIntegrationError } from "./types";

export function metaPublicOrigin(): string {
  return new URL(env.NEXT_PUBLIC_APP_URL).origin;
}
export const metaConnectionInputSchema = z.object({ connection_id: z.string().uuid() }).strict();
export const metaAssetSelectionInputSchema = metaConnectionInputSchema
  .extend({ asset_ids: z.array(z.string().uuid()).max(200) })
  .strict();

export async function metaAuthorize(request: Request, mutation: boolean) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  if (mutation && !sameOriginMutation(request, metaPublicOrigin())) {
    return {
      ok: false as const,
      response: fail("forbidden", "Esta ação precisa partir da própria aplicação.", 403, {
        requestId,
      }),
    };
  }
  const auth = await requireRole(mutation ? "admin" : "viewer", {
    requestId,
    resource: "meta_connections",
  });
  if (!auth.ok) return auth;
  if (
    mutation &&
    (await authRateLimited("meta_native", auth.user.id, { ip: 60, id: 20, windowSec: 300 }))
  ) {
    return {
      ok: false as const,
      response: fail("rate_limited", "Muitas tentativas. Aguarde alguns minutos.", 429, {
        requestId,
      }),
    };
  }
  const sessionId = mutation ? await authenticatedSessionId() : "";
  return {
    ok: true as const,
    actor: { organizationId: auth.org.orgId, actorId: auth.user.id, sessionId },
    requestId,
  };
}

export async function metaReadBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 65536)
    throw new MetaIntegrationError("invalid_request", "O pedido excede o tamanho permitido.", 413);
  const reader = request.body?.getReader();
  if (!reader)
    throw new MetaIntegrationError("invalid_request", "Informe um corpo JSON válido.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65536) {
        await reader.cancel();
        throw new MetaIntegrationError(
          "invalid_request",
          "O pedido excede o tamanho permitido.",
          413,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MetaIntegrationError("invalid_request", "Informe um corpo JSON válido.", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new MetaIntegrationError("invalid_request", "Confira os dados enviados.", 400);
  return parsed.data;
}

export function metaAPIError(error: unknown, requestId?: string) {
  if (error instanceof MetaIntegrationError)
    return fail(error.code, error.message, error.status, {
      requestId,
      headers: { "cache-control": "no-store" },
    });
  logger.error("[meta.native] falha interna da integração", {
    request_id: requestId ?? null,
    kind: error instanceof Error ? error.name : "unknown",
  });
  return fail(
    "upstream_unavailable",
    "Não foi possível concluir a ação Meta. Tente novamente.",
    503,
    { requestId, headers: { "cache-control": "no-store" } },
  );
}
