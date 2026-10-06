import { z } from "zod";
import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { metaAuthorize, metaAPIError, metaReadBody } from "@/lib/channels/meta/social/api";
import { metaOpaquePattern } from "@/lib/channels/meta/social/oauth";
import { MetaNativeService } from "@/lib/channels/meta/social/service";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const input = await metaReadBody(
      request,
      z.object({ ticket: z.string().regex(metaOpaquePattern) }).strict(),
    );
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
    const auth = await metaAuthorize(request, true);
    if (!auth.ok) return auth.response;
    return ok(await new MetaNativeService().finalize(auth.actor, input.ticket, requestId), {
      requestId,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
