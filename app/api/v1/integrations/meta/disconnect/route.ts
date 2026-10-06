import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  metaAuthorize,
  metaAPIError,
  metaReadBody,
  metaConnectionInputSchema,
} from "@/lib/channels/meta/social/api";
import { MetaNativeService } from "@/lib/channels/meta/social/service";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const input = await metaReadBody(request, metaConnectionInputSchema);
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
    const auth = await metaAuthorize(request, true);
    if (!auth.ok) return auth.response;
    return ok(
      await new MetaNativeService().disconnect(auth.actor, input.connection_id, requestId),
      { requestId, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
