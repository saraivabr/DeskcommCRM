import { z } from "zod";
import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  metaAuthorize,
  metaAPIError,
  metaReadBody,
  metaAssetSelectionInputSchema,
} from "@/lib/channels/meta/social/api";
import { MetaNativeService } from "@/lib/channels/meta/social/service";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const input = z
      .object({ connection_id: z.string().uuid() })
      .strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success)
      return metaAPIError(
        new MetaIntegrationError("invalid_request", "Informe uma conexão válida.", 400),
        requestId,
      );
    const auth = await metaAuthorize(request, false);
    if (!auth.ok) return auth.response;
    return ok(
      await new MetaNativeService().assets(auth.actor.organizationId, input.data.connection_id),
      { requestId, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    const input = await metaReadBody(request, metaAssetSelectionInputSchema);
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
    const auth = await metaAuthorize(request, true);
    if (!auth.ok) return auth.response;
    return ok(
      await new MetaNativeService().selectAssets(
        auth.actor,
        input.connection_id,
        input.asset_ids,
        requestId,
      ),
      { requestId, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
