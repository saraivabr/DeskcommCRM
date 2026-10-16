import { fail } from "@/lib/api/wrappers";
import { socialErrorDetails } from "@/lib/channels/social/client";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";

export function instagramAPIError(error: unknown, requestId: string) {
  const details = error instanceof MetaIntegrationError ? error : socialErrorDetails(error);
  return fail(details.code, details.message, details.status, {
    requestId,
    headers: {
      "Cache-Control": "no-store",
      ...(details.status === 429 ? { "Retry-After": "60" } : {}),
    },
  });
}
