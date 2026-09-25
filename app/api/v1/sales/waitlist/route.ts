import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { audit } from "@/lib/audit";

const schema = z
  .object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    company: z.string().trim().max(160).default(""),
    website: z.string().max(300).default(""),
  })
  .strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const accepted = (requestId: string) =>
  ok({ accepted: true }, { requestId, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const requestId = randomUUID();
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return fail("forbidden", "Não foi possível enviar este pedido.", 403, { requestId });
  }
  const denied = await requireSupportWrite();
  if (denied) return denied;
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    if (!(await checkRateLimit(`waitlist:ip:${hash(ip)}`, 5, 3600)).allowed) {
      return fail("rate_limited", "Aguarde um pouco antes de tentar novamente.", 429, {
        requestId,
        headers: { "Retry-After": "3600" },
      });
    }
    const reader = request.body?.getReader();
    if (!reader) return fail("validation_failed", "Confira seus dados.", 400, { requestId });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4096) {
        await reader.cancel();
        return fail("payload_too_large", "O pedido excedeu o tamanho permitido.", 413, {
          requestId,
        });
      }
      chunks.push(value);
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return fail("validation_failed", "Confira seus dados.", 400, { requestId });
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      return fail("validation_failed", "Confira seu nome e e-mail.", 400, { requestId });
    if (parsed.data.website) return accepted(requestId);
    const { name, email, company } = parsed.data;
    // Same reply for duplicate addresses and exhausted address budget; no enumeration.
    if (!(await checkRateLimit(`waitlist:email:${hash(email)}`, 3, 86400)).allowed)
      return accepted(requestId);
    const { rows } = await getRequestPool().query<{ id: string }>(
      "insert into public.sales_waitlist(name,email,company) values($1,$2,$3) on conflict(email) do nothing returning id",
      [name, email, company],
    );
    if (rows[0])
      await audit({
        action: "sales.waitlist_requested",
        resourceType: "sales_waitlist",
        resourceId: rows[0].id,
        requestId,
      });
    return accepted(requestId);
  } catch {
    return fail(
      "internal_error",
      "Não foi possível enviar agora. Tente novamente em instantes.",
      503,
      { requestId },
    );
  }
}
