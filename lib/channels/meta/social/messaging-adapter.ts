import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ChannelAdapter } from "../../types";
import { MetaGraphClient } from "./graph";
import { resolveSelectedMetaAsset } from "./operations";
import { messagingSession, META_SOCIAL_PROVIDER } from "./messaging-store";
import { MetaIntegrationError } from "./types";
import { metaMessageId } from "./messaging-events";
import { assertNativeMessagingRouting, messagingRequiredFields } from "./messaging-routing";

export const metaSocialAdapter: ChannelAdapter = {
  provider: META_SOCIAL_PROVIDER,
  resolveRecipient: (input) => (input.isGroup ? null : "provider-thread"),
  isConfigured: () => true,
  codes: {
    notConfigured: "meta_messaging_not_configured",
    sendFailed: "meta_messaging_send_failed",
    unknownError: "meta_messaging_unknown",
  },
  async send(envelope) {
    if (envelope.kind !== "text" || !envelope.body?.trim())
      throw new Error("Este canal aceita respostas de texto; aguarde uma mensagem do cliente.");
    const participant = envelope.providerConversationId;
    if (!participant || !/^\d{1,100}$/.test(participant))
      throw new Error("Aguarde uma mensagem do cliente para responder neste canal.");
    const db = createAdminClient();
    const session = await messagingSession(envelope.organizationId, envelope.sessionRef, db);
    // Defence at the transport seam: every caller must reply to an existing, recent inbound thread.
    const { data: conversation, error } = await db
      .from("conversations")
      .select("last_inbound_at")
      .eq("organization_id", envelope.organizationId)
      .eq("channel_session_id", session.id)
      .eq("provider_conversation_id", participant)
      .maybeSingle();
    const last = Date.parse(conversation?.last_inbound_at ?? "");
    if (error || !Number.isFinite(last) || last > Date.now() || Date.now() - last >= 86400000)
      throw new Error("A janela de 24 horas terminou. Aguarde uma nova mensagem do cliente.");
    const platform = session.metadata.social_platform;
    const resolved = await resolveSelectedMetaAsset(
      envelope.organizationId,
      session.meta_social_asset_id,
      platform === "instagram" ? "instagram_message" : "facebook_message",
      session.meta_social_connection_id,
      db,
    );
    await envelope.beforeSend?.();
    let result: unknown;
    try {
      result = await new MetaGraphClient(resolved.app).request(
        `${resolved.asset.external_id}/messages`,
        resolved.token,
        {
          method: "POST",
          body: {
            recipient: JSON.stringify({ id: participant }),
            message: JSON.stringify({ text: envelope.body }),
            ...(platform === "facebook" ? { messaging_type: "RESPONSE" } : {}),
          },
        },
      );
    } catch (error) {
      // The canonical handler persists failed, a terminal ledger result. Never queue/retry an ambiguous POST.
      if (error instanceof Error && "code" in error && error.code === "meta_provider_unavailable")
        throw new Error(
          "Envio sem confirmação da Meta. Confira a conversa antes de enviar novamente.",
        );
      throw error;
    }
    const receipt = z.object({ message_id: z.string().min(1).max(1000) }).safeParse(result);
    if (!receipt.success)
      throw new Error(
        "Envio sem confirmação da Meta. Confira a conversa antes de enviar novamente.",
      );
    return { externalId: metaMessageId(envelope.sessionRef, receipt.data.message_id) };
  },
  async checkHealth(input) {
    try {
      const session = await messagingSession(input.organizationId, input.sessionRef);
      const resolved = await resolveSelectedMetaAsset(
        input.organizationId,
        session.meta_social_asset_id,
        session.metadata.social_platform === "instagram" ? "instagram_message" : "facebook_message",
        session.meta_social_connection_id,
      );
      const platform = session.metadata.social_platform === "instagram" ? "instagram" : "facebook";
      const graph = new MetaGraphClient(resolved.app);
      await assertNativeMessagingRouting(graph, resolved.app, platform);
      const target =
        resolved.asset.kind === "instagram"
          ? resolved.asset.parent_page_external_id!
          : resolved.asset.external_id;
      const response = z
        .object({
          data: z.array(
            z.object({ id: z.string(), subscribed_fields: z.array(z.string()).optional() }),
          ),
        })
        .parse(await graph.request(`${target}/subscribed_apps`, resolved.token));
      const active = response.data.some(
        (item) =>
          item.id === resolved.app.appId &&
          messagingRequiredFields(platform).every((field) =>
            item.subscribed_fields?.includes(field),
          ),
      );
      return {
        reachable: true,
        status: active ? "WORKING" : "FAILED",
        detail: active ? null : "recebimento_nao_configurado",
      };
    } catch (error) {
      if (
        error instanceof MetaIntegrationError &&
        error.code === "meta_messaging_callback_mismatch"
      )
        return { reachable: true, status: "FAILED", detail: "callback_nao_configurado" };
      if (
        error instanceof MetaIntegrationError &&
        [
          "meta_provider_unavailable",
          "meta_provider_response_invalid",
          "meta_provider_error",
          "meta_store_unavailable",
        ].includes(error.code)
      )
        return { reachable: false, status: null, detail: "sonda_meta_inconclusiva" };
      if (error instanceof MetaIntegrationError)
        return {
          reachable: true,
          status: "FAILED",
          detail: "reautorize_o_atendimento_deste_ativo",
        };
      return { reachable: false, status: null, detail: "sonda_meta_inconclusiva" };
    }
  },
};
