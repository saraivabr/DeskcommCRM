import { z } from "zod";
import { ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import {
  metaAuthorize,
  metaAPIError,
  metaPublicOrigin,
  metaReadBody,
} from "@/lib/channels/meta/social/api";
import {
  META_CALLBACK_PATH,
  META_OAUTH_COOKIE,
  META_OAUTH_TTL_SECONDS,
} from "@/lib/channels/meta/social/oauth";
import { MetaNativeService } from "@/lib/channels/meta/social/service";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? undefined;
  try {
    await metaReadBody(request, z.object({}).strict());
    const supportDenied = await requireSupportWrite();
    if (supportDenied) return supportDenied;
    const auth = await metaAuthorize(request, true);
    if (!auth.ok) return auth.response;
    const result = await new MetaNativeService().start(auth.actor, metaPublicOrigin(), requestId);
    const response = ok(
      { authorization_url: result.authorization_url },
      { requestId, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
    );
    response.cookies.set(META_OAUTH_COOKIE, result.cookie, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: "lax",
      path: META_CALLBACK_PATH,
      maxAge: META_OAUTH_TTL_SECONDS,
    });
    return response;
  } catch (error) {
    return metaAPIError(error, requestId);
  }
}
