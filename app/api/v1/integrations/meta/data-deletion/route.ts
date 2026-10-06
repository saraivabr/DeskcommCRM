import { NextResponse } from "next/server";
import { metaAPIError, metaPublicOrigin } from "@/lib/channels/meta/social/api";
import { receiveMetaPrivacyRequest } from "@/lib/channels/meta/social/removal";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { confirmationCode } = await receiveMetaPrivacyRequest(request, "data_deletion");
    const url = new URL("/legal/meta-data-deletion/status", metaPublicOrigin());
    url.searchParams.set("code", confirmationCode);
    // Provider protocol requires these fields at the root, not our API envelope.
    return NextResponse.json(
      { url: url.toString(), confirmation_code: confirmationCode },
      {
        headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      },
    );
  } catch (error) {
    return metaAPIError(error, request.headers.get("x-request-id") ?? undefined);
  }
}
