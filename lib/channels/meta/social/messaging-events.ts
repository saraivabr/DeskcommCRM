import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SocialMessage } from "../../social/parser";

const id = z.string().regex(/^\d+$/).max(100);
const eventSchema = z.object({
  sender: z.object({ id }),
  recipient: z.object({ id }),
  timestamp: z.number().int().positive().max(8640000000000000),
  message: z
    .object({
      mid: z.string().min(1).max(1000),
      text: z.string().max(20000).optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      attachments: z.array(z.unknown()).max(20).optional(),
    })
    .optional(),
  delivery: z
    .object({
      mids: z.array(z.string().min(1).max(1000)).max(100),
      watermark: z.number().optional(),
    })
    .optional(),
  read: z
    .object({
      watermark: z.number().int().positive().max(8640000000000000).optional(),
      mid: z.string().min(1).max(1000).optional(),
    })
    .refine((value) => value.watermark !== undefined || value.mid !== undefined)
    .optional(),
});
export const messagingEnvelopeSchema = z.object({
  object: z.enum(["page", "instagram"]),
  entry: z
    .array(
      z.object({
        id,
        time: z.number().optional(),
        messaging: z.array(eventSchema).max(100).default([]),
      }),
    )
    .max(100),
});
export type MetaMessagingEnvelope = z.infer<typeof messagingEnvelopeSchema>;
export function metaMessageId(asset: string, message: string): string {
  return `meta:${asset}:${message}`;
}
export function verifyMetaMessagingSignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
/** Verify both entry and recipient; an echo swaps sender/recipient but never creates inbound demand. */
export function parseMetaMessagingEvent(
  platform: "instagram" | "facebook",
  entryId: string,
  value: unknown,
): SocialMessage[] {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) return [];
  const event = parsed.data;
  if (event.timestamp > Date.now() + 60000) return [];
  const echo = event.message?.is_echo === true;
  if ((echo ? event.sender.id : event.recipient.id) !== entryId) return [];
  const participant = echo ? event.recipient.id : event.sender.id;
  if (participant === entryId) return [];
  const base = {
    platform,
    participantId: participant,
    accountId: entryId,
    conversationId: participant,
    direction: echo ? ("outbound" as const) : ("inbound" as const),
    sentAt: new Date(event.timestamp).toISOString(),
    attachments: [],
    referral: null,
    identity: { phone: null, bsuid: null, anchor: null, username: null, displayName: null },
  };
  if (event.message && !event.message.is_deleted)
    return [
      {
        ...base,
        kind: "message",
        externalId: metaMessageId(entryId, event.message.mid),
        text:
          event.message.text ??
          (event.message.attachments?.length ? "[Anexo recebido nesta rede]" : null),
        ...(echo ? { status: "sent" as const } : {}),
      },
    ];
  if (event.delivery)
    return event.delivery.mids.map((mid) => ({
      ...base,
      direction: "outbound",
      kind: "status",
      externalId: metaMessageId(entryId, mid),
      text: null,
      status: "delivered",
    }));
  return [];
}
