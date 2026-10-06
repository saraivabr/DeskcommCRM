import { NextResponse } from "next/server";
import { metaAPIError } from "@/lib/channels/meta/social/api";
import { receiveMetaPrivacyRequest } from "@/lib/channels/meta/social/removal";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await receiveMetaPrivacyRequest(request, "deauthorization");
    return NextResponse.json({ success: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return metaAPIError(error, request.headers.get("x-request-id") ?? undefined);
  }
}
