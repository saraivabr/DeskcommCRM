import { createHash } from "node:crypto";
import { z } from "zod";
import { MetaIntegrationError } from "./types";
import type { MetaExecutionContext } from "./operations";

export const metaInstagramPayloadSchema = z
  .object({
    publication_id: z.uuid(),
    item_ids: z.array(z.uuid()).min(1).max(10),
    format: z.enum(["feed", "story", "carousel"]),
    caption: z.string().max(2200),
    media: z
      .array(
        z
          .object({
            storage_path: z.string().max(1000),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .refine(
    (v) =>
      v.item_ids.length === v.media.length &&
      (v.format === "carousel" ? v.media.length >= 2 : v.media.length === 1),
  );
export type MetaInstagramPayload = z.infer<typeof metaInstagramPayloadSchema>;
const idSchema = z.object({ id: z.string().regex(/^\d+$/) });
const statusSchema = z.object({
  status_code: z.enum(["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"]),
});
const nextCheck = () => new Date(Date.now() + 60_000).toISOString();
function storedId(ctx: MetaExecutionContext, key: string): string | null {
  const value = ctx.operation.external_ids[key];
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}
function error(code: string, message: string): MetaIntegrationError {
  return new MetaIntegrationError(code, message, 422);
}

/** The only public media URL comes from a verified immutable tenant Storage object. */
export async function signedPublicationMedia(
  ctx: MetaExecutionContext,
  payload: MetaInstagramPayload,
  index: number,
): Promise<string> {
  const media = payload.media[index];
  const expected = `${ctx.operation.organization_id}/instagram/publications/${payload.publication_id}/${index}.jpg`;
  if (!media || media.storage_path !== expected)
    throw error("meta_media_invalid", "A imagem preparada não pertence a esta publicação.");
  const storage = ctx.db.storage.from("whatsapp-media");
  const { data, error: downloadError } = await storage.download(expected);
  if (downloadError || !data || data.size > 8 * 1024 * 1024)
    throw error("meta_media_unavailable", "A imagem preparada está indisponível.");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== media.sha256)
    throw error("meta_media_changed", "A imagem mudou depois da aprovação desta publicação.");
  const signed = await storage.createSignedUrl(expected, 3600);
  if (signed.error || !signed.data?.signedUrl)
    throw error("meta_media_unavailable", "Não foi possível autorizar o acesso à imagem.");
  return signed.data.signedUrl;
}

/** Polls once per durable tick, following Meta's one-minute / five-check recommendation. */
async function containerReady(ctx: MetaExecutionContext, containerId: string): Promise<boolean> {
  const key = `checks_${containerId}`;
  const count = Number(ctx.operation.external_ids[key] ?? 0) + 1;
  const result = statusSchema.parse(
    await ctx.read(() =>
      ctx.graph.request(containerId, ctx.resolved.token, { query: { fields: "status_code" } }),
    ),
  );
  if (result.status_code === "FINISHED") return true;
  if (result.status_code === "PUBLISHED") {
    // A publish receipt was lost; the existing container must never be published again.
    await ctx.checkpoint({
      status: "uncertain",
      stage: "container_already_published",
      errorCode: "meta_publish_receipt_missing",
      errorMessage:
        "A Meta publicou o contêiner, mas o recibo ainda não está disponível. Não repita a publicação.",
    });
    return false;
  }
  if (["ERROR", "EXPIRED"].includes(result.status_code) || count >= 5) {
    await ctx.checkpoint({
      status: "failed",
      stage: "container_failed",
      errorCode: "meta_container_failed",
      errorMessage: "A Meta não concluiu o processamento da imagem. Prepare uma nova publicação.",
      externalIds: { [key]: count },
    });
    return false;
  }
  await ctx.checkpoint({
    status: "awaiting_provider",
    stage: "container_processing",
    externalIds: { [key]: count },
    retryAt: nextCheck(),
  });
  return false;
}

/** Durable Instagram image / carousel / eligible Business Story publication. */
export async function executeNativeInstagramOperation(ctx: MetaExecutionContext): Promise<void> {
  const payload = metaInstagramPayloadSchema.parse(ctx.operation.request_payload);
  if (ctx.resolved.asset.kind !== "instagram")
    throw error("meta_asset_invalid", "Selecione uma conta profissional do Instagram.");
  const instagramId = ctx.resolved.asset.external_id;
  if (payload.format === "story" && !storedId(ctx, "container_id")) {
    const account = z
      .object({ account_type: z.string() })
      .safeParse(
        await ctx.read(() =>
          ctx.graph.request(instagramId, ctx.resolved.token, { query: { fields: "account_type" } }),
        ),
      );
    if (!account.success || account.data.account_type !== "BUSINESS")
      throw error(
        "meta_story_not_eligible",
        "Stories exigem uma conta Business cuja elegibilidade a Meta confirme.",
      );
  }
  let mediaId = storedId(ctx, "media_id");
  if (!mediaId) {
    if (payload.format === "carousel") {
      const children: string[] = [];
      for (let i = 0; i < payload.media.length; i++) {
        let child = storedId(ctx, `child_${i}`);
        if (!child) {
          const imageUrl = await signedPublicationMedia(ctx, payload, i);
          const created = await ctx.dispatch(
            `child_${i}_created`,
            () =>
              ctx.graph.request(`${instagramId}/media`, ctx.resolved.token, {
                method: "POST",
                body: { image_url: imageUrl, is_carousel_item: "true" },
              }),
            (result) => ({ [`child_${i}`]: idSchema.parse(result).id }),
          );
          child = idSchema.parse(created).id;
        }
        children.push(child);
      }
      // Child containers have to finish before their parent can be created.
      if (!storedId(ctx, "container_id")) {
        for (const child of children) if (!(await containerReady(ctx, child))) return;
        await ctx.dispatch(
          "carousel_container_created",
          () =>
            ctx.graph.request(`${instagramId}/media`, ctx.resolved.token, {
              method: "POST",
              body: {
                media_type: "CAROUSEL",
                children: children.join(","),
                caption: payload.caption,
              },
            }),
          (result) => ({ container_id: idSchema.parse(result).id }),
        );
      }
    } else if (!storedId(ctx, "container_id")) {
      const imageUrl = await signedPublicationMedia(ctx, payload, 0);
      await ctx.dispatch(
        "container_created",
        () =>
          ctx.graph.request(`${instagramId}/media`, ctx.resolved.token, {
            method: "POST",
            body: {
              image_url: imageUrl,
              ...(payload.format === "story"
                ? { media_type: "STORIES" }
                : { caption: payload.caption }),
            },
          }),
        (result) => ({ container_id: idSchema.parse(result).id }),
      );
    }
    const container = storedId(ctx, "container_id");
    if (!container)
      throw error(
        "meta_container_missing",
        "Não foi possível recuperar o contêiner desta publicação.",
      );
    if (!(await containerReady(ctx, container))) return;
    await ctx.dispatch(
      "published",
      () =>
        ctx.graph.request(`${instagramId}/media_publish`, ctx.resolved.token, {
          method: "POST",
          body: { creation_id: container },
        }),
      (result) => ({ media_id: idSchema.parse(result).id }),
      undefined,
      (result) => ({
        media_id: idSchema.parse(result).id,
        provider_post_id: idSchema.parse(result).id,
        permalink: null,
      }),
    );
    mediaId = storedId(ctx, "media_id")!;
  }
  // media_publish confirmed this ID. Save success before an optional read or authorization change.
  if (ctx.operation.status !== "succeeded")
    await ctx.checkpoint({
      status: "succeeded",
      stage: "completed",
      receipt: { media_id: mediaId, provider_post_id: mediaId, permalink: null },
    });
  await ctx.enrichReceipt(async () => {
    const media = z
      .object({ id: z.string(), permalink: z.string().url().optional() })
      .parse(
        await ctx.graph.request(mediaId!, ctx.resolved.token, {
          query: { fields: "id,permalink" },
        }),
      );
    if (media.id !== mediaId)
      throw error("meta_publish_receipt_invalid", "O recibo não corresponde a esta publicação.");
    return {
      permalink:
        media.permalink && /^https:\/\/(?:www\.)?instagram\.com\//.test(media.permalink)
          ? media.permalink
          : null,
    };
  });
}
