import { createAdminClient } from "@/lib/supabase/admin";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
/** Durable input already passed app HMAC. Database consumption rebinds every tenant/asset/grant. */
export async function consumeNativeMessagingEvent(row: EventRow): Promise<HandlerResult> {
  try {
    const { data, error } = await createAdminClient().rpc("fn_meta_messaging_ingest", {
      p_event_id: row.id,
    });
    if (error)
      return {
        consumer_key: "native_messaging_v1",
        status: "error",
        detail: "messaging_persistence_failed",
      };
    return {
      consumer_key: "native_messaging_v1",
      status: data === true ? "ok" : "skipped",
      detail: data === true ? undefined : "authorization_changed",
    };
  } catch {
    return {
      consumer_key: "native_messaging_v1",
      status: "error",
      detail: "messaging_persistence_failed",
    };
  }
}
