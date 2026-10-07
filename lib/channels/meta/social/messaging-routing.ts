import { z } from "zod";
import { metaPublicOrigin } from "./api";
import type { MetaGraphClient } from "./graph";
import { MetaIntegrationError, type MetaNativeApp } from "./types";

export const META_SOCIAL_WEBHOOK_PATH = "/api/v1/webhooks/meta-social";
export function messagingRequiredFields(platform: "instagram" | "facebook"): string[] {
  return [
    "messages",
    "messaging_postbacks",
    ...(platform === "instagram"
      ? ["messaging_seen"]
      : ["message_echoes", "message_deliveries", "message_reads"]),
  ];
}
const routingSchema = z.object({
  data: z
    .array(
      z.object({
        object: z.string(),
        active: z.boolean(),
        callback_url: z.string(),
        fields: z.array(z.object({ name: z.string() })),
      }),
    )
    .max(200),
});

/** Read-only proof of the app destination, separate from the Page subscription. */
export async function assertNativeMessagingRouting(
  graph: MetaGraphClient,
  app: MetaNativeApp,
  platform: "instagram" | "facebook",
): Promise<void> {
  const response = await graph.request(
    `${app.appId}/subscriptions`,
    `${app.appId}|${app.appSecret}`,
    { appToken: true },
  );
  const parsed = routingSchema.safeParse(response);
  if (!parsed.success)
    throw new MetaIntegrationError(
      "meta_provider_response_invalid",
      "A Meta não confirmou o destino do webhook.",
    );
  const matches = parsed.data.data.filter(
    (item) => item.object === (platform === "instagram" ? "instagram" : "page"),
  );
  const expected = new URL(META_SOCIAL_WEBHOOK_PATH, metaPublicOrigin()).toString();
  const subscription = matches[0];
  if (
    matches.length !== 1 ||
    !subscription?.active ||
    subscription.callback_url !== expected ||
    !messagingRequiredFields(platform).every((field) =>
      subscription.fields.some((item) => item.name === field),
    )
  )
    throw new MetaIntegrationError(
      "meta_messaging_callback_mismatch",
      "O webhook deste app ainda não aponta para o atendimento nativo. Configure o destino sem substituir fluxos existentes.",
      409,
    );
}
