import { timingSafeEqual } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { appDaMeta, getPlatformMetaAppPrivacy } from "@/lib/channels/meta/app";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  messagingEnvelopeSchema,
  verifyMetaMessagingSignature,
} from "@/lib/channels/meta/social/messaging-events";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const app = await appDaMeta();
  const supplied = q.get("hub.verify_token") ?? "";
  const expected = app.verifyToken ?? "";
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    q.get("hub.mode") !== "subscribe" ||
    !expected ||
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  )
    return fail("forbidden", "Verificação recusada.", 403);
  const challenge = q.get("hub.challenge") ?? "";
  if (!/^\d{1,200}$/.test(challenge)) return fail("invalid_request", "Desafio inválido.", 400);
  // Meta requires the challenge as literal text, not the application JSON envelope.
  return new Response(challenge, {
    headers: { "content-type": "text/plain", "cache-control": "no-store" },
  });
}
export async function POST(request: Request) {
  if (
    await authRateLimited("meta_messaging_webhook", "installation", {
      ip: 1000,
      id: 1000,
      windowSec: 60,
    })
  )
    return fail("rate_limited", "Aguarde antes de repetir.", 429);
  const reader = request.body?.getReader();
  if (!reader) return fail("invalid_request", "Corpo ausente.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1048576) {
        await reader.cancel();
        return fail("invalid_request", "Corpo muito grande.", 413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const app = await getPlatformMetaAppPrivacy();
    if (!app) return fail("upstream_unavailable", "Assinatura não configurada.", 503);
    if (
      !verifyMetaMessagingSignature(raw, request.headers.get("x-hub-signature-256"), app.appSecret)
    )
      return fail("forbidden", "Assinatura recusada.", 403);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail("invalid_request", "JSON inválido.", 400);
    }
    const parsed = messagingEnvelopeSchema.safeParse(body);
    if (!parsed.success) return fail("invalid_request", "Evento inválido.", 400);
    const { data: received, error } = await createAdminClient().rpc("fn_meta_messaging_accept", {
      p_envelope: parsed.data,
    });
    if (error) throw new Error("messaging_queue_persistence_failed");
    return ok({ received });
  } catch {
    return fail(
      "upstream_unavailable",
      "Não foi possível persistir o evento. A entrega será repetida.",
      503,
    );
  }
}
