import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { metaReadBody, metaAPIError } from "@/lib/channels/meta/social/api";
import { authorizeAds } from "@/lib/ads/api";
import { draftEditSchema } from "@/lib/ads/schema";
import { getDraft, saveDraft } from "@/lib/ads/drafts";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(req: Request, context: Context) {
  const auth = await authorizeAds(req);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Rascunho inválido.", 422, { requestId: auth.requestId });
  try {
    return ok(await getDraft(auth.org.orgId, id), {
      requestId: auth.requestId,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return metaAPIError(error, auth.requestId);
  }
}
export async function PATCH(req: Request, context: Context) {
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await authorizeAds(req, true);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Rascunho inválido.", 422, { requestId: auth.requestId });
  try {
    const input = await metaReadBody(req, draftEditSchema);
    if (input.id !== id)
      return fail("validation_failed", "O rascunho informado não corresponde à edição.", 422, {
        requestId: auth.requestId,
      });
    const { revision, ...content } = input;
    const draft = await saveDraft(auth.org.orgId, auth.user.id, content, revision);
    void audit({
      action: "meta.campaign_draft_updated",
      actorUserId: auth.user.id,
      organizationId: auth.org.orgId,
      resourceType: "meta_campaign_draft",
      resourceId: id,
      requestId: auth.requestId,
      metadata: { revision: draft.revision },
    });
    return ok(draft, { requestId: auth.requestId, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return metaAPIError(error, auth.requestId);
  }
}
