import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { metaReadBody, metaAPIError } from "@/lib/channels/meta/social/api";
import { authorizeAds } from "@/lib/ads/api";
import { draftApproveSchema } from "@/lib/ads/schema";
import { approveDraft } from "@/lib/ads/drafts";
export const dynamic = "force-dynamic";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await authorizeAds(req, true);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Rascunho inválido.", 422, { requestId: auth.requestId });
  try {
    const draft = await approveDraft(
      auth.org.orgId,
      id,
      await metaReadBody(req, draftApproveSchema),
    );
    void audit({
      action: "meta.campaign_approved",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "meta_campaign_draft",
      resourceId: id,
      requestId: auth.requestId,
      metadata: {
        revision: draft.revision,
        approved_hash: draft.approved_hash,
        daily_budget_cents: draft.daily_budget_cents,
        currency: draft.currency,
      },
    });
    return ok(draft, { requestId: auth.requestId, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return metaAPIError(error, auth.requestId);
  }
}
