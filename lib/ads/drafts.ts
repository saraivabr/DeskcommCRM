import { z } from "zod";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMetaAsset, MetaOperationStore } from "@/lib/channels/meta/social/operations";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import { draftInputSchema, trafficTargeting, type AdDraftInput } from "./schema";
import { draftReviewHash, imageReviewHash } from "./review";
import type { AdCampaignDraftDTO, AdDraftContextDTO, AdOperationDTO } from "./types";

const iso = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.iso.datetime(),
);
const storedCreative = z
  .object({
    studio_item_id: z.uuid(),
    message: z.string(),
    title: z.string(),
    connection_id: z.uuid(),
    authorization_version: z.number().int().positive(),
    image_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    asset_path: z.string(),
  })
  .strict();
const storedSchema = z.object({
  id: z.uuid(),
  revision: z.coerce.number().int().positive(),
  status: z.enum(["draft", "approved", "submitted", "archived"]),
  ad_account_asset_id: z.uuid(),
  page_asset_id: z.uuid(),
  name: z.string(),
  objective: z.literal("OUTCOME_TRAFFIC"),
  destination_url: z.string(),
  daily_budget_cents: z.coerce.number().int(),
  currency: z.enum(["BRL", "USD", "EUR"]),
  starts_at: iso,
  ends_at: iso,
  targeting: z.unknown(),
  creative: storedCreative,
  approved_revision: z.coerce.number().nullable(),
  approved_hash: z.string().nullable(),
});
export type StoredAdDraft = z.infer<typeof storedSchema>;
const columns =
  "id,revision,status,ad_account_asset_id,page_asset_id,name,objective,destination_url,daily_budget_cents,currency,starts_at,ends_at,targeting,creative,approved_revision,approved_hash";
function invalid(message: string, code = "meta_draft_invalid", status = 422): never {
  throw new MetaIntegrationError(code, message, status);
}

export function reviewedDraft(draft: StoredAdDraft) {
  const { status: _status, approved_hash: _hash, approved_revision: _revision, ...content } = draft;
  return content;
}
export function reviewHash(draft: StoredAdDraft) {
  return draftReviewHash(reviewedDraft(draft));
}

/** Página escolhida na mesma autorização; não basta a conta de anúncios estar válida. */
export async function requireAdPage(
  organizationId: string,
  pageId: string,
  connectionId: string,
  version: number,
  appId: string,
) {
  const { rows } = await getRequestPool().query(
    `select a.external_id,g.tasks,g.permissions,c.scopes,c.granular_scopes from meta_assets a
     join meta_asset_grants g on g.organization_id=a.organization_id and g.asset_id=a.id
     join meta_connections c on c.organization_id=g.organization_id and c.id=g.connection_id
     where a.organization_id=$1 and a.id=$2 and a.kind='page' and g.connection_id=$3
       and g.selected and g.status='healthy' and c.status='healthy' and c.version=$4 and c.app_id=$5`,
    [organizationId, pageId, connectionId, version, appId],
  );
  const parsed = z
    .object({
      external_id: z.string().regex(/^\d+$/),
      tasks: z.array(z.string()),
      permissions: z.array(z.string()),
      scopes: z.array(z.string()),
      granular_scopes: z.array(
        z.object({ scope: z.string(), target_ids: z.array(z.string()).optional() }),
      ),
    })
    .safeParse(rows[0]);
  if (!parsed.success)
    invalid(
      "Selecione uma Página válida na mesma conexão da conta de anúncios.",
      "meta_page_not_authorized",
      409,
    );
  const page = parsed.data;
  if (!page.tasks.some((task) => ["ADVERTISE", "MANAGE", "ADMIN"].includes(task)))
    invalid(
      "A Página escolhida não permite criar anúncios. Reautorize o acesso.",
      "meta_page_not_authorized",
      422,
    );
  for (const scope of ["pages_show_list", "pages_read_engagement"]) {
    const granular = page.granular_scopes.filter((grant) => grant.scope === scope);
    if (
      !page.scopes.includes(scope) ||
      !page.permissions.includes(scope) ||
      (granular.length &&
        !granular.some(
          (grant) => grant.target_ids === undefined || grant.target_ids.includes(page.external_id),
        ))
    )
      invalid(
        "Faltam permissões para usar esta Página no anúncio. Reautorize o acesso.",
        "meta_page_not_authorized",
        422,
      );
  }
  return page.external_id;
}

/** Mídia vem exclusivamente do armazenamento privado da organização. */
export async function loadDraftImage(
  organizationId: string,
  itemId: string,
  expectedPath?: string,
) {
  const { rows } = await getRequestPool().query<{ asset_path: string; input: { format?: string } }>(
    "select asset_path,input from instagram_studio_items where organization_id=$1 and id=$2 and kind='post' and status='ready'",
    [organizationId, itemId],
  );
  const item = rows[0];
  if (
    !item?.asset_path?.startsWith(`${organizationId}/instagram/`) ||
    (expectedPath && item.asset_path !== expectedPath) ||
    !["square", "feed"].includes(item.input?.format ?? "")
  )
    invalid("Escolha uma imagem pronta de feed ou quadrada no Studio desta empresa.");
  const downloaded = await createAdminClient()
    .storage.from("whatsapp-media")
    .download(item.asset_path);
  if (downloaded.error || !downloaded.data)
    invalid("A imagem não está disponível. Abra o Studio e escolha outra imagem.");
  if (downloaded.data.size > 8 * 1024 * 1024)
    invalid("A imagem excede o limite de 8 MB desta entrega.");
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  return { bytes, path: item.asset_path, hash: imageReviewHash(bytes) };
}

async function operationForDraft(
  organizationId: string,
  draftId: string,
): Promise<AdOperationDTO | null> {
  const { rows } = await getRequestPool().query<{
    id: string;
    status: AdOperationDTO["status"];
    stage: string;
    external_ids: Record<string, unknown>;
    error_message: string | null;
  }>(
    "select id,status,stage,external_ids,error_message from meta_operations where organization_id=$1 and campaign_draft_id=$2 and kind='ads_create' order by created_at desc limit 1",
    [organizationId, draftId],
  );
  const row = rows[0];
  if (!row) return null;
  const external_ids: Record<string, string> = {};
  for (const key of ["campaign_id", "adset_id", "creative_id", "ad_id", "image_hash"]) {
    const value = row.external_ids?.[key];
    if (typeof value === "string" && /^[a-zA-Z0-9_:-]{1,200}$/.test(value))
      external_ids[key] = value;
  }
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    external_ids,
    error_message: row.error_message,
  };
}
async function dto(organizationId: string, draft: StoredAdDraft): Promise<AdCampaignDraftDTO> {
  return {
    id: draft.id,
    revision: draft.revision,
    status: draft.status,
    connection_id: draft.creative.connection_id,
    ad_account_asset_id: draft.ad_account_asset_id,
    page_asset_id: draft.page_asset_id,
    name: draft.name,
    objective: draft.objective,
    destination_url: draft.destination_url,
    daily_budget_cents: draft.daily_budget_cents,
    currency: draft.currency,
    starts_at: draft.starts_at,
    ends_at: draft.ends_at,
    creative: {
      studio_item_id: draft.creative.studio_item_id,
      message: draft.creative.message,
      title: draft.creative.title,
    },
    review_hash: reviewHash(draft),
    approved_hash: draft.approved_hash,
    operation: await operationForDraft(organizationId, draft.id),
  };
}
export async function loadStoredDraft(
  organizationId: string,
  draftId: string,
): Promise<StoredAdDraft> {
  const { rows } = await getRequestPool().query(
    `select ${columns} from meta_campaign_drafts where organization_id=$1 and id=$2`,
    [organizationId, draftId],
  );
  if (!rows[0]) invalid("Rascunho não encontrado nesta empresa.", "meta_draft_not_found", 404);
  const parsed = storedSchema.safeParse(rows[0]);
  if (!parsed.success)
    invalid(
      "Este rascunho usa uma versão que não pode ser criada nesta entrega.",
      "meta_draft_incompatible",
      409,
    );
  return parsed.data;
}
export async function getDraft(organizationId: string, draftId: string) {
  return dto(organizationId, await loadStoredDraft(organizationId, draftId));
}

export async function adDraftContext(organizationId: string): Promise<AdDraftContextDTO> {
  const pool = getRequestPool();
  const [drafts, pages, images] = await Promise.all([
    pool.query(
      `select ${columns} from meta_campaign_drafts where organization_id=$1 and objective='OUTCOME_TRAFFIC' order by updated_at desc limit 30`,
      [organizationId],
    ),
    pool.query<{ asset_id: string; connection_id: string; name: string }>(
      `select a.id as asset_id,g.connection_id,a.name from meta_assets a join meta_asset_grants g on g.organization_id=a.organization_id and g.asset_id=a.id join meta_connections c on c.organization_id=g.organization_id and c.id=g.connection_id where a.organization_id=$1 and a.kind='page' and g.selected and g.status='healthy' and c.status='healthy' and g.tasks && array['ADVERTISE','MANAGE','ADMIN'] order by a.name limit 100`,
      [organizationId],
    ),
    pool.query<{ id: string; asset_path: string; caption: string }>(
      "select id,asset_path,caption from instagram_studio_items where organization_id=$1 and kind='post' and status='ready' and input->>'format' in ('feed','square') order by created_at desc limit 30",
      [organizationId],
    ),
  ]);
  const parsedDrafts = drafts.rows.map((row) => {
    const parsed = storedSchema.safeParse(row);
    if (!parsed.success)
      invalid(
        "Um rascunho salvo usa um formato que não pode ser revisado nesta entrega.",
        "meta_draft_incompatible",
        409,
      );
    return parsed.data;
  });
  const safeImages = await Promise.all(
    images.rows
      .filter((image) => image.asset_path?.startsWith(`${organizationId}/instagram/`))
      .map(async (image) => {
        const signed = await createAdminClient()
          .storage.from("whatsapp-media")
          .createSignedUrl(image.asset_path, 3600);
        return {
          id: image.id,
          name: image.caption?.slice(0, 80) || "Imagem do Studio",
          preview_url: signed.error ? null : signed.data.signedUrl,
        };
      }),
  );
  return {
    drafts: await Promise.all(parsedDrafts.map((draft) => dto(organizationId, draft))),
    pages: pages.rows,
    images: safeImages,
  };
}

export async function saveDraft(
  organizationId: string,
  actorId: string,
  input: AdDraftInput,
  expectedRevision?: number,
): Promise<AdCampaignDraftDTO> {
  const binding = await resolveMetaAsset(
    organizationId,
    input.ad_account_asset_id,
    "ads_manage",
    input.connection_id,
  );
  if (binding.asset.currency !== input.currency)
    invalid(
      "A moeda deve ser a mesma da conta de anúncios. Atualize as contas.",
      "meta_currency_mismatch",
      409,
    );
  if (!binding.asset.timezone)
    invalid("A Meta não informou o fuso da conta. Verifique a conexão antes de continuar.");
  if (Date.parse(input.starts_at) <= Date.now())
    invalid("Escolha um início futuro para esta campanha.");
  await requireAdPage(
    organizationId,
    input.page_asset_id,
    binding.connectionId,
    binding.authorizationVersion,
    binding.app.appId!,
  );
  const image = await loadDraftImage(organizationId, input.creative.studio_item_id);
  const creative = {
    ...input.creative,
    connection_id: binding.connectionId,
    authorization_version: binding.authorizationVersion,
    image_sha256: image.hash,
    asset_path: image.path,
  };
  const values = [
    organizationId,
    actorId,
    input.id,
    input.ad_account_asset_id,
    input.page_asset_id,
    input.name,
    input.destination_url,
    input.daily_budget_cents,
    input.currency,
    input.starts_at,
    input.ends_at,
    JSON.stringify(trafficTargeting),
    JSON.stringify(creative),
  ];
  if (expectedRevision !== undefined) {
    const updated = await getRequestPool().query(
      `update meta_campaign_drafts set ad_account_asset_id=$3,page_asset_id=$4,name=$5,destination_url=$6,daily_budget_cents=$7,currency=$8,starts_at=$9,ends_at=$10,targeting=$11::jsonb,creative=$12::jsonb,updated_at=now() where organization_id=$1 and id=$2 and revision=$13 and status in ('draft','approved') returning id`,
      [organizationId, ...values.slice(2), expectedRevision],
    );
    if (!updated.rowCount)
      invalid(
        "O rascunho mudou ou já foi enviado. Atualize antes de editar.",
        "meta_draft_changed",
        409,
      );
  } else {
    const created = await getRequestPool().query(
      `insert into meta_campaign_drafts(organization_id,created_by,id,ad_account_asset_id,page_asset_id,name,objective,destination_url,daily_budget_cents,currency,starts_at,ends_at,targeting,creative) values($1,$2,$3,$4,$5,$6,'OUTCOME_TRAFFIC',$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) on conflict(organization_id,id) do nothing returning id`,
      values,
    );
    if (!created.rowCount) {
      const existing = await loadStoredDraft(organizationId, input.id);
      const parsed = draftInputSchema.parse({
        ...input,
        id: existing.id,
        connection_id: existing.creative.connection_id,
        ad_account_asset_id: existing.ad_account_asset_id,
        page_asset_id: existing.page_asset_id,
        name: existing.name,
        destination_url: existing.destination_url,
        daily_budget_cents: existing.daily_budget_cents,
        currency: existing.currency,
        starts_at: existing.starts_at,
        ends_at: existing.ends_at,
        creative: {
          studio_item_id: existing.creative.studio_item_id,
          message: existing.creative.message,
          title: existing.creative.title,
        },
      });
      if (draftReviewHash(parsed) !== draftReviewHash(input))
        invalid(
          "Este rascunho já existe com outro conteúdo. Atualize a tela.",
          "meta_draft_changed",
          409,
        );
    }
  }
  return getDraft(organizationId, input.id);
}

export async function approveDraft(
  organizationId: string,
  draftId: string,
  input: { revision: number; review_hash: string; daily_budget_cents: number; currency: string },
) {
  const draft = await loadStoredDraft(organizationId, draftId);
  if (
    draft.revision !== input.revision ||
    reviewHash(draft) !== input.review_hash ||
    draft.daily_budget_cents !== input.daily_budget_cents ||
    draft.currency !== input.currency ||
    !["draft", "approved"].includes(draft.status)
  )
    invalid("A revisão ou o orçamento mudou. Abra a revisão novamente.", "meta_draft_changed", 409);
  const binding = await resolveMetaAsset(
    organizationId,
    draft.ad_account_asset_id,
    "ads_manage",
    draft.creative.connection_id,
  );
  if (
    binding.authorizationVersion !== draft.creative.authorization_version ||
    binding.asset.currency !== draft.currency
  )
    invalid(
      "A autorização ou a moeda mudou. Edite e revise o rascunho novamente.",
      "meta_authorization_changed",
      409,
    );
  await requireAdPage(
    organizationId,
    draft.page_asset_id,
    binding.connectionId,
    binding.authorizationVersion,
    binding.app.appId!,
  );
  const image = await loadDraftImage(
    organizationId,
    draft.creative.studio_item_id,
    draft.creative.asset_path,
  );
  if (image.hash !== draft.creative.image_sha256)
    invalid("A imagem mudou. Edite e revise o rascunho novamente.", "meta_draft_changed", 409);
  if (Date.parse(draft.starts_at) <= Date.now())
    invalid("O início da campanha venceu. Edite o período antes de aprovar.");
  const updated = await getRequestPool().query(
    "update meta_campaign_drafts set status='approved',approved_revision=revision,approved_hash=$4,updated_at=now() where organization_id=$1 and id=$2 and revision=$3 and status in ('draft','approved') returning id",
    [organizationId, draftId, input.revision, input.review_hash],
  );
  if (!updated.rowCount)
    invalid("O rascunho mudou durante a aprovação. Atualize a revisão.", "meta_draft_changed", 409);
  return getDraft(organizationId, draftId);
}

export async function createPausedDraft(
  organizationId: string,
  actorId: string,
  draftId: string,
  input: { revision: number; approved_hash: string },
) {
  const draft = await loadStoredDraft(organizationId, draftId);
  if (
    !["approved", "submitted"].includes(draft.status) ||
    draft.revision !== input.revision ||
    draft.approved_revision !== input.revision ||
    draft.approved_hash !== input.approved_hash ||
    reviewHash(draft) !== input.approved_hash
  )
    invalid(
      "Aprove esta revisão e seu orçamento antes de criar a campanha.",
      "meta_draft_not_approved",
      409,
    );
  const binding = await resolveMetaAsset(
    organizationId,
    draft.ad_account_asset_id,
    "ads_manage",
    draft.creative.connection_id,
  );
  if (
    binding.authorizationVersion !== draft.creative.authorization_version ||
    binding.asset.currency !== draft.currency
  )
    invalid("A autorização mudou. Revise o rascunho novamente.", "meta_authorization_changed", 409);
  await requireAdPage(
    organizationId,
    draft.page_asset_id,
    binding.connectionId,
    binding.authorizationVersion,
    binding.app.appId!,
  );
  await new MetaOperationStore().reserve({
    organizationId,
    actorId,
    connectionId: binding.connectionId,
    assetId: draft.ad_account_asset_id,
    grantId: binding.grantId,
    authorizationVersion: binding.authorizationVersion,
    kind: "ads_create",
    operationKey: `ads-create:${draft.id}:${draft.revision}`,
    payload: {
      campaign_draft_id: draft.id,
      draft_revision: draft.revision,
      approved_hash: input.approved_hash,
    },
  });
  await getRequestPool().query(
    "update meta_campaign_drafts set status='submitted',updated_at=now() where organization_id=$1 and id=$2 and revision=$3 and approved_hash=$4 and status='approved'",
    [organizationId, draft.id, draft.revision, input.approved_hash],
  );
  return getDraft(organizationId, draftId);
}
