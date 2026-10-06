import { z } from "zod";
import type { MetaExecutionContext } from "@/lib/channels/meta/social/operations";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import {
  loadStoredDraft,
  loadDraftImage,
  requireAdPage,
  reviewHash,
  type StoredAdDraft,
} from "@/lib/ads/drafts";
import { trafficTargeting } from "@/lib/ads/schema";
import { draftReviewHash } from "@/lib/ads/review";

const payload = z
  .object({
    campaign_draft_id: z.uuid(),
    draft_revision: z.number().int().positive(),
    approved_hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const idResult = z.object({ id: z.string().regex(/^\d+$/) });
function blocked(message = "A revisão ou a autorização da campanha mudou."): never {
  throw new MetaIntegrationError("meta_draft_changed", message, 409);
}
function checkDraft(
  context: MetaExecutionContext,
  draft: StoredAdDraft,
  intent: z.infer<typeof payload>,
) {
  const operation = context.operation;
  if (
    operation.kind !== "ads_create" ||
    draft.ad_account_asset_id !== operation.asset_id ||
    draft.creative.connection_id !== operation.connection_id ||
    draft.creative.authorization_version !== operation.authorization_version ||
    draft.revision !== intent.draft_revision ||
    draft.approved_revision !== intent.draft_revision ||
    draft.approved_hash !== intent.approved_hash ||
    reviewHash(draft) !== intent.approved_hash ||
    !["approved", "submitted"].includes(draft.status) ||
    draftReviewHash(draft.targeting) !== draftReviewHash(trafficTargeting)
  )
    blocked();
  if (context.resolved.asset.currency !== draft.currency)
    blocked("A moeda da conta mudou. Revise o orçamento novamente.");
}

/** Uma intenção durável, checkpoints por objeto e nenhuma ativação implícita. */
export async function executeNativeAdsOperation(context: MetaExecutionContext): Promise<void> {
  const parsed = payload.safeParse(context.operation.request_payload);
  if (!parsed.success) blocked("A intenção da campanha não pode ser conferida.");
  const intent = parsed.data;
  const org = context.operation.organization_id;
  let draft = await loadStoredDraft(org, intent.campaign_draft_id);
  checkDraft(context, draft, intent);
  if (Date.parse(draft.starts_at) <= Date.now() || Date.parse(draft.ends_at) <= Date.now())
    blocked("O período desta revisão venceu. Edite e aprove um novo rascunho.");
  let pageId = "";
  const guard = async () => {
    draft = await loadStoredDraft(org, intent.campaign_draft_id);
    checkDraft(context, draft, intent);
    pageId = await requireAdPage(
      org,
      draft.page_asset_id,
      context.resolved.connectionId,
      context.resolved.authorizationVersion,
      context.resolved.app.appId!,
    );
  };
  await context.beforeDispatch();
  await guard();
  const image = await loadDraftImage(org, draft.creative.studio_item_id, draft.creative.asset_path);
  if (image.hash !== draft.creative.image_sha256)
    blocked("A imagem aprovada mudou. Revise o rascunho novamente.");
  const accountPath = `act_${context.resolved.asset.external_id.replace(/^act_/, "")}`;
  const ids = context.operation.external_ids;
  const known = (key: string, pattern = /^\d+$/) => {
    const value = ids[key];
    if (value === undefined) return null;
    if (typeof value !== "string" || !pattern.test(value))
      blocked("Um recibo da campanha não pôde ser conferido.");
    return value;
  };
  const post = async (path: string, body: Record<string, string>) =>
    idResult.parse(
      await context.graph.request(path, context.resolved.token, { method: "POST", body }),
    );
  let imageHash = known("image_hash", /^[a-f0-9]{32,64}$/);
  if (!imageHash) {
    const uploaded = await context.dispatch(
      "image_uploaded",
      async () => {
        const result = z
          .object({
            images: z.record(z.string(), z.object({ hash: z.string().regex(/^[a-f0-9]{32,64}$/) })),
          })
          .parse(
            await context.graph.request(`${accountPath}/adimages`, context.resolved.token, {
              method: "POST",
              body: { bytes: image.bytes.toString("base64") },
            }),
          );
        const hash = Object.values(result.images)[0]?.hash;
        if (!hash) throw new Error("missing image receipt");
        return hash;
      },
      (hash) => ({ image_hash: hash }),
      guard,
    );
    imageHash = uploaded;
  }
  let campaignId = known("campaign_id");
  if (!campaignId) {
    const result = await context.dispatch(
      "campaign_created",
      () =>
        post(`${accountPath}/campaigns`, {
          name: draft.name,
          objective: "OUTCOME_TRAFFIC",
          special_ad_categories: "[]",
          status: "PAUSED",
          is_adset_budget_sharing_enabled: "false",
        }),
      (result) => ({ campaign_id: result.id }),
      guard,
    );
    campaignId = result.id;
  }
  let adsetId = known("adset_id");
  if (!adsetId) {
    const result = await context.dispatch(
      "adset_created",
      () =>
        post(`${accountPath}/adsets`, {
          name: `${draft.name} · Brasil`,
          campaign_id: campaignId!,
          daily_budget: String(draft.daily_budget_cents),
          billing_event: "IMPRESSIONS",
          optimization_goal: "LINK_CLICKS",
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          destination_type: "WEBSITE",
          targeting: JSON.stringify(trafficTargeting),
          start_time: draft.starts_at,
          end_time: draft.ends_at,
          status: "PAUSED",
        }),
      (result) => ({ adset_id: result.id }),
      guard,
    );
    adsetId = result.id;
  }
  let creativeId = known("creative_id");
  if (!creativeId) {
    const result = await context.dispatch(
      "creative_created",
      () =>
        post(`${accountPath}/adcreatives`, {
          name: `${draft.name} · Criativo`,
          object_story_spec: JSON.stringify({
            page_id: pageId,
            link_data: {
              link: draft.destination_url,
              image_hash: imageHash,
              message: draft.creative.message,
              name: draft.creative.title,
              call_to_action: { type: "LEARN_MORE", value: { link: draft.destination_url } },
            },
          }),
        }),
      (result) => ({ creative_id: result.id }),
      guard,
    );
    creativeId = result.id;
  }
  let adId = known("ad_id");
  if (!adId) {
    const result = await context.dispatch(
      "ad_created",
      () =>
        post(`${accountPath}/ads`, {
          name: draft.name,
          adset_id: adsetId!,
          creative: JSON.stringify({ creative_id: creativeId }),
          status: "PAUSED",
        }),
      (result) => ({ ad_id: result.id }),
      guard,
    );
    adId = result.id;
  }
  const [account, campaign, adset, ad] = await context.read(() =>
    Promise.all([
      context.graph.request(accountPath, context.resolved.token, {
        query: { fields: "id,currency,account_status" },
      }),
      context.graph.request(campaignId!, context.resolved.token, {
        query: { fields: "id,status,account_id,objective" },
      }),
      context.graph.request(adsetId!, context.resolved.token, {
        query: { fields: "id,status,campaign_id,daily_budget,start_time,end_time" },
      }),
      context.graph.request(adId!, context.resolved.token, {
        query: { fields: "id,status,account_id,adset_id,campaign_id,creative{id}" },
      }),
    ]),
  );
  const accountRead = z.object({ currency: z.string(), account_status: z.number() }).parse(account);
  const campaignRead = z
    .object({ id: z.string(), status: z.string(), account_id: z.string(), objective: z.string() })
    .parse(campaign);
  const adsetRead = z
    .object({
      id: z.string(),
      status: z.string(),
      campaign_id: z.string(),
      daily_budget: z.string().regex(/^\d+$/),
      start_time: z.string(),
      end_time: z.string(),
    })
    .parse(adset);
  const adRead = z
    .object({
      id: z.string(),
      status: z.string(),
      account_id: z.string(),
      adset_id: z.string(),
      campaign_id: z.string(),
      creative: z.object({ id: z.string() }),
    })
    .parse(ad);
  const remoteAccount = context.resolved.asset.external_id.replace(/^act_/, "");
  if (
    accountRead.currency !== draft.currency ||
    accountRead.account_status !== 1 ||
    campaignRead.id !== campaignId ||
    campaignRead.status !== "PAUSED" ||
    campaignRead.account_id !== remoteAccount ||
    campaignRead.objective !== "OUTCOME_TRAFFIC" ||
    adsetRead.id !== adsetId ||
    adsetRead.status !== "PAUSED" ||
    adsetRead.campaign_id !== campaignId ||
    Number(adsetRead.daily_budget) !== draft.daily_budget_cents ||
    Date.parse(adsetRead.start_time) !== Date.parse(draft.starts_at) ||
    Date.parse(adsetRead.end_time) !== Date.parse(draft.ends_at) ||
    adRead.id !== adId ||
    adRead.status !== "PAUSED" ||
    adRead.account_id !== remoteAccount ||
    adRead.campaign_id !== campaignId ||
    adRead.adset_id !== adsetId ||
    adRead.creative.id !== creativeId
  ) {
    await context.checkpoint({
      status: "uncertain",
      stage: "verification_required",
      errorCode: "meta_campaign_receipt_mismatch",
      errorMessage:
        "A Meta criou objetos, mas os estados ou valores não correspondem à revisão. Confira os IDs antes de continuar.",
    });
    return;
  }
  await guard();
  await context.checkpoint({
    status: "succeeded",
    stage: "paused_verified",
    receipt: {
      campaign_id: campaignId,
      adset_id: adsetId,
      creative_id: creativeId,
      ad_id: adId,
      status: "PAUSED",
      daily_budget_cents: draft.daily_budget_cents,
      currency: draft.currency,
      verified_at: new Date().toISOString(),
    },
  });
}
