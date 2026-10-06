import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { metaReadBody, metaAPIError } from "@/lib/channels/meta/social/api";
import { authorizeAds } from "@/lib/ads/api";
import { draftInputSchema } from "@/lib/ads/schema";
import { adDraftContext, saveDraft } from "@/lib/ads/drafts";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const auth = await authorizeAds(req);
  if (!auth.ok) return auth.response;
  try {
    return ok(await adDraftContext(auth.org.orgId), {
      requestId: auth.requestId,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return metaAPIError(error, auth.requestId);
  }
}
export async function POST(req: Request) {
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await authorizeAds(req, true);
  if (!auth.ok) return auth.response;
  try {
    const input = await metaReadBody(req, draftInputSchema);
    const draft = await saveDraft(auth.org.orgId, auth.user.id, input);
    void audit({
      action: "meta.campaign_draft_updated",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "meta_campaign_draft",
      resourceId: draft.id,
      requestId: auth.requestId,
      metadata: {
        revision: draft.revision,
        daily_budget_cents: draft.daily_budget_cents,
        currency: draft.currency,
      },
    });
    return ok(draft, { requestId: auth.requestId, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return metaAPIError(error, auth.requestId);
  }
}
