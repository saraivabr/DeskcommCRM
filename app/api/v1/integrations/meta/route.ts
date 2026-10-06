import { ok } from "@/lib/api/wrappers";
import { metaAuthorize, metaAPIError } from "@/lib/channels/meta/social/api";
import { MetaNativeService } from "@/lib/channels/meta/social/service";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const auth = await metaAuthorize(request, false);
    if (!auth.ok) return auth.response;
    return ok(await new MetaNativeService().status(auth.actor.organizationId), {
      requestId,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
