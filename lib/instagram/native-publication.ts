import { createHash } from "node:crypto";
import sharp from "sharp";
import type { z } from "zod";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import {
  MetaOperationStore,
  resolveSelectedMetaAsset,
  metaOperationDTO,
} from "@/lib/channels/meta/social/operations";
import { MetaNativeService } from "@/lib/channels/meta/social/service";
import { MetaIntegrationError } from "@/lib/channels/meta/social/types";
import type { MetaInstagramPayload } from "@/lib/channels/meta/social/publish";
import type { nativePublicationInput, Publication } from "./publication-schema";

export const publicationColumns =
  "id,account_id,item_ids,format,caption,status,provider_post_id,permalink,error,created_at,provider,meta_asset_id,operation_id,requested_by";
export async function nativePublicationResult(
  organizationId: string,
  publication: Publication,
  store = new MetaOperationStore(),
) {
  if (!publication.operation_id || publication.provider !== "meta") return publication;
  const operation = await store.get(organizationId, publication.operation_id);
  if (!operation)
    throw invalid(
      "meta_store_unavailable",
      "Não foi possível consultar o resultado deste envio.",
      503,
    );
  const status: Publication["status"] =
    operation.status === "succeeded"
      ? "published"
      : operation.status === "uncertain"
        ? "uncertain"
        : ["failed", "blocked", "cancelled"].includes(operation.status)
          ? "failed"
          : operation.status === "awaiting_provider"
            ? "pending"
            : "sending";
  return {
    ...publication,
    status,
    connection_id: operation.connection_id,
    error: operation.error_message,
    provider_post_id:
      typeof operation.receipt?.media_id === "string"
        ? operation.receipt.media_id
        : publication.provider_post_id,
    permalink:
      typeof operation.receipt?.permalink === "string"
        ? operation.receipt.permalink
        : publication.permalink,
    operation: metaOperationDTO(operation),
  };
}
function invalid(code: string, message: string, status = 422): MetaIntegrationError {
  return new MetaIntegrationError(code, message, status);
}
export async function listNativeInstagramAccounts(organizationId: string) {
  const service = new MetaNativeService();
  const status = await service.status(organizationId);
  if (!status.configured || !status.capabilities.instagram_publish) return [];
  const result: {
    id: string;
    provider: "meta";
    meta_asset_id: string;
    connection_id: string;
    username: string;
    active: boolean;
    story_eligible: boolean;
  }[] = [];
  for (const connection of status.connections.filter((c) => c.status === "healthy")) {
    const { assets } = await service.assets(organizationId, connection.id);
    for (const asset of assets.filter((a) => a.kind === "instagram" && a.selected)) {
      result.push({
        id: asset.id,
        provider: "meta",
        meta_asset_id: asset.id,
        connection_id: connection.id,
        username: asset.username ?? asset.name,
        active: asset.capabilities.instagram_publish,
        // Eligibility is confirmed by Graph before creating a Story, never inferred from the relationship name.
        story_eligible: false,
      });
    }
  }
  return result;
}
export async function queueNativeInstagramPublication(
  organizationId: string,
  actorId: string,
  input: z.infer<typeof nativePublicationInput>,
  requestId?: string,
) {
  const pool = getRequestPool();
  const db = createAdminClient();
  const store = new MetaOperationStore(db);
  const existing = await pool.query<Publication>(
    `select ${publicationColumns} from instagram_publications where organization_id=$1 and id=$2`,
    [organizationId, input.id],
  );
  let previous = existing.rows[0];
  if (previous) {
    if (
      previous.provider !== "meta" ||
      previous.meta_asset_id !== input.meta_asset_id ||
      previous.requested_by !== actorId ||
      previous.format !== input.format ||
      previous.caption !== input.caption ||
      JSON.stringify(previous.item_ids) !== JSON.stringify(input.item_ids)
    )
      throw invalid("meta_idempotency_conflict", "Este envio já existe com outro conteúdo.", 409);
    if (previous.operation_id) {
      const operation = await store.get(organizationId, previous.operation_id);
      if (!operation || operation.connection_id !== input.connection_id)
        throw invalid("meta_idempotency_conflict", "Este envio pertence a outra autorização.", 409);
      return nativePublicationResult(organizationId, previous, store);
    }
    if (previous.status !== "preparing") return previous;
  } else {
    const limit = await checkRateLimit(`instagram-publish:${organizationId}`, 20, 3600);
    if (!limit.allowed)
      throw invalid(
        "rate_limited",
        "Limite de publicações atingido. Aguarde para publicar novamente.",
        429,
      );
  }
  let publicationClaimed = !!previous;
  try {
    const resolved = await resolveSelectedMetaAsset(
      organizationId,
      input.meta_asset_id,
      "instagram_publish",
      input.connection_id,
      db,
    );
    const items = await pool.query<{ id: string; asset_path: string; input: { format: string } }>(
      "select id,asset_path,input from instagram_studio_items where organization_id=$1 and id=any($2::uuid[]) and kind='post' and status='ready'",
      [organizationId, input.item_ids],
    );
    if (items.rows.length !== input.item_ids.length)
      throw invalid(
        "meta_media_invalid",
        "Todas as imagens precisam estar prontas e pertencer à sua empresa.",
      );
    if (input.format === "story" && items.rows[0]?.input.format !== "story")
      throw invalid("meta_media_invalid", "Use uma imagem no formato Story.");
    const media: MetaInstagramPayload["media"] = [];
    const storage = db.storage.from("whatsapp-media");
    for (const [index, id] of input.item_ids.entries()) {
      const item = items.rows.find((row) => row.id === id)!;
      if (!item.asset_path?.startsWith(`${organizationId}/instagram/`))
        throw invalid("meta_media_invalid", "Imagem indisponível para esta organização.");
      const source = await storage.download(item.asset_path);
      if (source.error || !source.data || source.data.size > 20 * 1024 * 1024)
        throw invalid("meta_media_unavailable", "Não foi possível preparar a imagem.");
      const buffer = await sharp(Buffer.from(await source.data.arrayBuffer()), {
        limitInputPixels: 40_000_000,
      })
        .rotate()
        .resize(
          1080,
          input.format === "story"
            ? 1920
            : items.rows.find((row) => row.id === input.item_ids[0])?.input.format === "square"
              ? 1080
              : 1350,
          { fit: "contain", background: "#ffffff" },
        )
        .jpeg({ quality: 92 })
        .toBuffer();
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const target = `${organizationId}/instagram/publications/${input.id}/${index}.jpg`;
      const uploaded = await storage.upload(target, buffer, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (uploaded.error) {
        const old = await storage.download(target);
        if (
          old.error ||
          !old.data ||
          createHash("sha256")
            .update(Buffer.from(await old.data.arrayBuffer()))
            .digest("hex") !== sha256
        )
          throw invalid(
            "meta_media_changed",
            "Não foi possível salvar a imagem preparada sem alterar o envio existente.",
            409,
          );
      }
      media.push({ storage_path: target, sha256 });
    }
    if (!previous) {
      const claimed = await pool.query<Publication>(
        `insert into instagram_publications(id,organization_id,account_id,item_ids,format,caption,provider,meta_asset_id,requested_by,status)
      values($1,$2,$3,$4,$5,$6,'meta',$7,$8,'preparing') on conflict do nothing returning ${publicationColumns}`,
        [
          input.id,
          organizationId,
          resolved.asset.external_id,
          input.item_ids,
          input.format,
          input.caption,
          input.meta_asset_id,
          actorId,
        ],
      );
      previous = claimed.rows[0];
      publicationClaimed = !!previous;
      if (!previous)
        throw invalid(
          "meta_idempotency_conflict",
          "Publicação já em preparação. Atualize os resultados.",
          409,
        );
    }
    const payload: MetaInstagramPayload = {
      publication_id: input.id,
      item_ids: input.item_ids,
      format: input.format,
      caption: input.caption,
      media,
    };
    const { operation } = await store.reserve({
      organizationId,
      actorId,
      connectionId: resolved.connectionId,
      assetId: resolved.asset.id,
      grantId: resolved.grantId,
      authorizationVersion: resolved.authorizationVersion,
      kind: "instagram_publish",
      operationKey: input.id,
      payload,
    });
    void audit({
      action: "meta.operation_requested",
      actorUserId: actorId,
      organizationId,
      resourceType: "instagram_publication",
      resourceId: input.id,
      requestId,
      metadata: { provider: "meta", operation_id: operation.id, status: "queued" },
    });
    const current = await pool.query<Publication>(
      `select ${publicationColumns} from instagram_publications where organization_id=$1 and id=$2`,
      [organizationId, input.id],
    );
    if (!current.rows[0])
      throw invalid("meta_store_unavailable", "Não foi possível consultar o envio reservado.", 503);
    return {
      ...current.rows[0],
      connection_id: operation.connection_id,
      operation: metaOperationDTO(operation),
    };
  } catch (error) {
    if (publicationClaimed) {
      // Preparation has no external effect. A reserve may have committed even
      // if its HTTP response was lost, so delete only an unbound provisional
      // row. The row lock serializes this with reserve's atomic operation link.
      await pool.query(
        "delete from instagram_publications where organization_id=$1 and id=$2 and requested_by=$3 and provider='meta' and status='preparing' and operation_id is null",
        [organizationId, input.id, actorId],
      );
    }
    throw error;
  }
}
