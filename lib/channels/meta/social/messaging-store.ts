import { randomBytes } from "node:crypto";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { MetaGraphClient } from "./graph";
import { resolveSelectedMetaAsset } from "./operations";
import { MetaIntegrationError, type MetaMessagingStatusDTO } from "./types";
import type { MetaActorContext } from "./store";
import {
  assertNativeMessagingRouting,
  messagingRequiredFields,
  META_SOCIAL_WEBHOOK_PATH,
} from "./messaging-routing";
export { META_SOCIAL_WEBHOOK_PATH } from "./messaging-routing";

export const META_SOCIAL_PROVIDER = "meta_social" as const;
const subscriptionSchema = z.object({
  data: z
    .array(z.object({ id: z.string(), subscribed_fields: z.array(z.string()).optional() }))
    .max(200),
});
const sessionSchema = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  meta_social_asset_id: z.uuid(),
  meta_social_connection_id: z.uuid(),
  meta_social_external_id: z.string().regex(/^\d+$/),
  status: z.string(),
  updated_at: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});
export type MetaMessagingSession = z.infer<typeof sessionSchema>;
const fields =
  "id,organization_id,meta_social_asset_id,meta_social_connection_id,meta_social_external_id,status,updated_at,metadata";
export async function metaMessagingStatus(
  org: string,
  origin: string,
  db = createAdminClient(),
): Promise<MetaMessagingStatusDTO> {
  const { data, error } = await db
    .from("channel_sessions")
    .select(fields)
    .eq("organization_id", org)
    .eq("provider", META_SOCIAL_PROVIDER)
    .is("archived_at", null);
  if (error)
    throw new MetaIntegrationError(
      "meta_store_unavailable",
      "Não foi possível consultar os canais.",
    );
  return {
    channels: (data ?? []).map((row) => {
      const s = sessionSchema.parse(row);
      return {
        id: s.id,
        asset_id: s.meta_social_asset_id,
        platform: s.metadata.social_platform === "instagram" ? "instagram" : "facebook",
        status: s.status,
        last_error:
          typeof s.metadata.messaging_error === "string" ? s.metadata.messaging_error : null,
      };
    }),
    webhook_url: new URL(META_SOCIAL_WEBHOOK_PATH, origin).toString(),
  };
}
export async function messagingSession(
  org: string,
  external: string,
  db = createAdminClient(),
): Promise<MetaMessagingSession> {
  const { data, error } = await db
    .from("channel_sessions")
    .select(fields)
    .eq("organization_id", org)
    .eq("provider", META_SOCIAL_PROVIDER)
    .eq("meta_social_external_id", external)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data)
    throw new MetaIntegrationError(
      "meta_messaging_unavailable",
      "Conecte o atendimento deste ativo antes de responder.",
      409,
    );
  const session = sessionSchema.parse(data);
  if (session.status !== "WORKING")
    throw new MetaIntegrationError(
      "meta_messaging_unavailable",
      "O canal de atendimento precisa de atenção.",
      409,
    );
  return session;
}
/** A signed entry id only resolves a globally unique active channel; never use a tenant from payload. */
export async function resolveMessagingEntry(
  external: string,
  platform: "instagram" | "facebook",
  db = createAdminClient(),
): Promise<MetaMessagingSession | null> {
  const { data, error } = await db.rpc("fn_meta_messaging_resolve_entry", {
    p_external_id: external,
    p_platform: platform,
  });
  if (error)
    throw new MetaIntegrationError("meta_store_unavailable", "Não foi possível resolver o canal.");
  if (!Array.isArray(data) || !data.length) return null;
  if (data.length !== 1)
    throw new MetaIntegrationError(
      "meta_messaging_ambiguous",
      "Ativo associado a mais de uma organização.",
      409,
    );
  const session = sessionSchema.parse(data[0]);
  return session.metadata.social_platform === platform ? session : null;
}
export async function configureMetaMessaging(
  actor: MetaActorContext,
  assetId: string,
  action: "enable" | "disable",
  origin: string,
  db = createAdminClient(),
): Promise<MetaMessagingStatusDTO> {
  const { data: existing, error: readError } = await db
    .from("channel_sessions")
    .select(fields)
    .eq("organization_id", actor.organizationId)
    .eq("provider", META_SOCIAL_PROVIDER)
    .eq("meta_social_asset_id", assetId)
    .is("archived_at", null)
    .maybeSingle();
  if (readError)
    throw new MetaIntegrationError("meta_store_unavailable", "Não foi possível consultar o canal.");
  if (action === "disable") {
    if (existing) {
      const { error } = await db
        .from("channel_sessions")
        .update({ status: "STOPPED" })
        .eq("organization_id", actor.organizationId)
        .eq("id", existing.id);
      if (error)
        throw new MetaIntegrationError(
          "meta_store_unavailable",
          "Não foi possível interromper o canal.",
        );
    }
    void audit({
      action: "channel.messaging_disabled",
      actorUserId: actor.actorId,
      organizationId: actor.organizationId,
      resourceType: "channel_sessions",
      resourceId: existing?.id,
    });
    return metaMessagingStatus(actor.organizationId, origin, db);
  }
  const { data: asset, error: assetError } = await db
    .from("meta_assets")
    .select("kind")
    .eq("organization_id", actor.organizationId)
    .eq("id", assetId)
    .maybeSingle();
  if (assetError || !asset || !["instagram", "page"].includes(asset.kind))
    throw new MetaIntegrationError(
      "meta_asset_not_found",
      "Escolha uma Página ou Instagram autorizado.",
      404,
    );
  const platform = asset.kind === "instagram" ? "instagram" : "facebook";
  const resolved = await resolveSelectedMetaAsset(
    actor.organizationId,
    assetId,
    platform === "instagram" ? "instagram_message" : "facebook_message",
    undefined,
    db,
  );
  const graph = new MetaGraphClient(resolved.app);
  await assertNativeMessagingRouting(graph, resolved.app, platform);
  const metadata = {
    ...((existing?.metadata as Record<string, unknown>) ?? metadataInicialDoCanal()),
    social_platform: platform,
    messaging_error: null,
  };
  let channelId = existing?.id;
  if (existing) {
    if (existing.status === "STARTING" && Date.now() - Date.parse(existing.updated_at) < 90000)
      throw new MetaIntegrationError(
        "meta_messaging_busy",
        "Aguarde a configuração em andamento.",
        409,
      );
    const { data: claimed, error } = await db
      .from("channel_sessions")
      .update({
        status: "STARTING",
        metadata,
        meta_social_connection_id: resolved.connectionId,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", actor.organizationId)
      .eq("id", existing.id)
      .eq("updated_at", existing.updated_at)
      .select("id")
      .maybeSingle();
    if (error || !claimed)
      throw new MetaIntegrationError(
        "meta_messaging_busy",
        "Outra configuração está em andamento.",
        409,
      );
  } else {
    const placeholder = await encryptWebhookSecret(db, randomBytes(32).toString("hex"));
    if (!placeholder)
      throw new MetaIntegrationError(
        "meta_encryption_unavailable",
        "A instalação precisa configurar a cifra das credenciais.",
      );
    const { data, error } = await db
      .from("channel_sessions")
      .insert({
        organization_id: actor.organizationId,
        provider: META_SOCIAL_PROVIDER,
        webhook_secret_encrypted: placeholder,
        meta_social_asset_id: assetId,
        meta_social_external_id: resolved.asset.external_id,
        meta_social_connection_id: resolved.connectionId,
        display_name: `${platform} · ${resolved.asset.name}`,
        status: "STARTING",
        metadata,
      })
      .select("id")
      .single();
    if (error || !data)
      throw new MetaIntegrationError(
        "meta_messaging_conflict",
        "Este ativo já está conectado ou o limite de canais foi atingido.",
        409,
      );
    channelId = data.id;
  }
  try {
    const target =
      platform === "instagram"
        ? resolved.asset.parent_page_external_id!
        : resolved.asset.external_id;
    const subscribed = subscriptionSchema.parse(
      await graph.request(`${target}/subscribed_apps`, resolved.token),
    );
    const found = subscribed.data.find((item) => item.id === resolved.app.appId);
    const requiredFields = messagingRequiredFields(platform);
    if (!requiredFields.every((field) => found?.subscribed_fields?.includes(field)))
      await graph.request(`${target}/subscribed_apps`, resolved.token, {
        method: "POST",
        body: {
          subscribed_fields: [
            ...new Set([...(found?.subscribed_fields ?? []), ...requiredFields]),
          ].join(","),
        },
      });
    const verified = subscriptionSchema.parse(
      await graph.request(`${target}/subscribed_apps`, resolved.token),
    );
    if (
      !verified.data.some(
        (item) =>
          item.id === resolved.app.appId &&
          requiredFields.every((field) => item.subscribed_fields?.includes(field)),
      )
    )
      throw new MetaIntegrationError(
        "meta_subscription_unconfirmed",
        "A Meta não confirmou o recebimento de mensagens.",
        502,
      );
    // Revalidate the selected grant after the external operation, so disconnect cannot resurrect a channel.
    await resolveSelectedMetaAsset(
      actor.organizationId,
      assetId,
      platform === "instagram" ? "instagram_message" : "facebook_message",
      resolved.connectionId,
      db,
    );
    const { data: confirmedChannel, error } = await db
      .from("channel_sessions")
      .update({
        status: "WORKING",
        metadata: { ...metadata, messaging_subscription_verified_at: new Date().toISOString() },
      })
      .eq("organization_id", actor.organizationId)
      .eq("id", channelId!)
      .eq("status", "STARTING")
      .select("id")
      .maybeSingle();
    if (error || !confirmedChannel)
      throw new MetaIntegrationError(
        "meta_store_unavailable",
        "A assinatura foi confirmada, mas o canal não pôde ser salvo.",
      );
    void audit({
      action: "channel.messaging_enabled",
      actorUserId: actor.actorId,
      organizationId: actor.organizationId,
      resourceType: "channel_sessions",
      resourceId: channelId,
      metadata: { platform, asset_id: assetId },
    });
  } catch (error) {
    const code = error instanceof MetaIntegrationError ? error.code : "meta_subscription_failed";
    await db
      .from("channel_sessions")
      .update({ status: "FAILED", metadata: { ...metadata, messaging_error: code } })
      .eq("organization_id", actor.organizationId)
      .eq("id", channelId!)
      .eq("status", "STARTING");
    throw error;
  }
  return metaMessagingStatus(actor.organizationId, origin, db);
}
