import type { EventHandler } from "@/lib/event-log/dispatcher";
import { ENTENDEDOR_CONSUMER_KEY, EVENTO_ENTENDEDOR, entenderAudio } from "@/workers/entendedor-de-audio";

export const entendedorDeAudioHandler: EventHandler = {
  key: ENTENDEDOR_CONSUMER_KEY,
  events: [EVENTO_ENTENDEDOR],
  handle: (row) => entenderAudio(row),
};
