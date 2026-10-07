import type { EventHandler } from "@/lib/event-log/dispatcher";
import { consumeNativeMessagingEvent } from "@/lib/channels/meta/social/messaging-consumer";
export const nativeMessagingHandler: EventHandler = {
  key: "native_messaging_v1",
  events: ["channel.messaging_received"],
  handle: consumeNativeMessagingEvent,
};
