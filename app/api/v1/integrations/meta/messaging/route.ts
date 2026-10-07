import { z } from "zod";
import { ok } from "@/lib/api/wrappers";
import {
  metaAuthorize,
  metaAPIError,
  metaPublicOrigin,
  metaReadBody,
} from "@/lib/channels/meta/social/api";
import {
  configureMetaMessaging,
  metaMessagingStatus,
} from "@/lib/channels/meta/social/messaging-store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const auth = await metaAuthorize(request, false);
    if (!auth.ok) return auth.response;
    return ok(await metaMessagingStatus(auth.actor.organizationId, metaPublicOrigin()), {
      requestId,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const auth = await metaAuthorize(request, true);
    if (!auth.ok) return auth.response;
    const body = await metaReadBody(
      request,
      z.object({ action: z.enum(["enable", "disable"]), asset_id: z.uuid() }).strict(),
    );
    return ok(
      await configureMetaMessaging(auth.actor, body.asset_id, body.action, metaPublicOrigin()),
      { requestId, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
