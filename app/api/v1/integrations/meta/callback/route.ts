import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authRateLimited } from "@/lib/auth/rate-limit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { metaPublicOrigin } from "@/lib/channels/meta/social/api";
import {
  META_CALLBACK_PATH,
  META_OAUTH_COOKIE,
  metaOpaquePattern,
  metaBridgeHTML,
  metaCallbackDestination,
  opaqueNonce,
} from "@/lib/channels/meta/social/oauth";
import { MetaNativeService } from "@/lib/channels/meta/social/service";

export const dynamic = "force-dynamic";
const callbackSchema = z.object({
  state: z.string().regex(metaOpaquePattern),
  code: z.string().min(1).max(16384).optional(),
  error: z.string().min(1).max(200).optional(),
});
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  let result: Parameters<typeof metaCallbackDestination>[0] = { error: "invalid_state" };
  const query = callbackSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  const cookie = request.cookies.get(META_OAUTH_COOKIE)?.value;
  try {
    if (
      query.success &&
      cookie &&
      metaOpaquePattern.test(cookie) &&
      !(await authRateLimited("meta_callback", query.data.state, { ip: 60, id: 3, windowSec: 300 }))
    ) {
      result = await new MetaNativeService().callback(
        query.data,
        cookie,
        metaPublicOrigin(),
        requestId,
      );
    }
  } catch {
    result = { error: "provider_error" };
  }
  const nonce = opaqueNonce();
  // Bridge HTML é uma navegação browser, não resposta JSON de API.
  const response = new NextResponse(metaBridgeHTML(metaCallbackDestination(result), nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    },
  });
  response.cookies.set(META_OAUTH_COOKIE, "", {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: META_CALLBACK_PATH,
    maxAge: 0,
  });
  return response;
}
