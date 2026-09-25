import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient, type WahaHistoryMessage } from "@/lib/waha/client";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

const MESSAGES_PER_STEP = 100;
const STEPS_PER_RUN = 8;

type Session = { id: string; organization_id: string; waha_session_name: string; status: string };
type Progress = {
  organization_id: string; channel_session_id: string; status: string;
  chat_offset: number; message_offset: number; chats_imported: number; messages_imported: number;
  scan_pass: number; started_at?: string | null; finished_at?: string | null;
};

/** Apenas conversas 1:1, as mesmas que o CRM atende. */
export function identityFromHistoryChat(chatId: string): { kind: "phone" | "lid"; value: string } | null {
  if (chatId.length > 128) return null;
  const parts = chatId.split("@");
  if (parts.length !== 2) return null;
  const [value, suffix] = parts;
  if (!value || !/^\d{8,20}$/.test(value)) return null;
  if ((suffix === "c.us" || suffix === "s.whatsapp.net") && value.length <= 15)
    return { kind: "phone", value: `+${value}` };
  if (suffix === "lid") return { kind: "lid", value };
  return null;
}

export function historySentAt(value: WahaHistoryMessage["timestamp"]): string | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  const ms = n < 100_000_000_000 ? n * 1000 : n;
  if (ms > Date.now() + 86_400_000) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function syncWhatsappHistory(): Promise<{ sessions: number; messages: number; failures: number }> {
  const admin = createAdminClient();
  const waha = getWahaClient();
  if (!waha) return { sessions: 0, messages: 0, failures: 0 };
  const { data, error } = await admin.from("channel_sessions")
    .select("id,organization_id,waha_session_name,status")
    .eq("status", "WORKING").is("archived_at", null).not("waha_session_name", "is", null);
  if (error) throw new Error(`history_sessions_${error.code}`);
  let sessions = 0; let messages = 0; let failures = 0;
  for (const session of (data ?? []) as Session[]) {
    const result = await syncSession(admin, waha, session);
    if (result === null) failures++;
    else { sessions++; messages += result; }
  }
  return { sessions, messages, failures };
}

type Admin = ReturnType<typeof createAdminClient>;
type Waha = NonNullable<ReturnType<typeof getWahaClient>>;

async function syncSession(admin: Admin, waha: Waha, session: Session): Promise<number | null> {
  const org = session.organization_id;
  const sid = session.id;
  const { data: prior, error: readError } = await admin.from("whatsapp_history_syncs" as never)
    .select("*").eq("organization_id", org).eq("channel_session_id", sid).maybeSingle();
  if (readError) return null;
  let progress = (prior as Progress | null) ?? {
    organization_id: org, channel_session_id: sid, status: "pending",
    chat_offset: 0, message_offset: 0, chats_imported: 0, messages_imported: 0, scan_pass: 0,
  };
  if (progress.status === "complete") {
    const last = Date.parse(progress.finished_at ?? "");
    const first = Date.parse(progress.started_at ?? "");
    // NOWEB pode ainda estar sincronizando o telefone quando o primeiro passe
    // termina. Releitura deduplicada por uma semana pega a chegada tardia.
    if (!Number.isFinite(last) || !Number.isFinite(first) ||
        Date.now() - last < 6 * 60 * 60_000 || Date.now() - first > 7 * 24 * 60 * 60_000) return 0;
    progress = { ...progress, status: "running", chat_offset: 0, message_offset: 0, scan_pass: progress.scan_pass + 1 };
  }
  try {
    const remote = await waha.getVerifiedSession(session.waha_session_name);
    const store = (remote?.config?.noweb as { store?: { enabled?: boolean } } | undefined)?.store;
    if (!remote || remote.status !== "WORKING") throw new Error("history_session_not_ready");
    if (store?.enabled !== true) {
      await admin.from("whatsapp_history_syncs" as never).upsert({ ...progress,
        status: "unsupported", error_code: "store_not_enabled_before_pairing", updated_at: new Date().toISOString(),
      } as never);
      return 0;
    }
    if (!progress.started_at) progress = { ...progress, started_at: new Date().toISOString() };
    const { error: startError } = await admin.from("whatsapp_history_syncs" as never)
      .upsert({ ...progress, status: "running", updated_at: new Date().toISOString() } as never);
    if (startError) throw new Error(`history_start_${startError.code}`);
    const persistCursor = async () => {
      const { error: cursorError } = await admin.from("whatsapp_history_syncs" as never)
        .upsert({ ...progress, status: "running", error_code: null, updated_at: new Date().toISOString() } as never);
      if (cursorError) throw new Error(`history_cursor_${cursorError.code}`);
    };
    let inserted = 0;
    for (let step = 0; step < STEPS_PER_RUN; step++) {
      const chats = await waha.listHistoryChats(session.waha_session_name, progress.chat_offset, 1);
      if (chats.length === 0) { progress = { ...progress, status: "complete" }; break; }
      const chatId = chats[0]!.id;
      const identity = identityFromHistoryChat(chatId);
      if (!identity) {
        progress = { ...progress, chat_offset: progress.chat_offset + 1, message_offset: 0 };
        await persistCursor();
        continue;
      }
      const { data: erased, error: erasureError } = await admin.rpc("fn_whatsapp_history_chat_erased" as never, {
        p_org: org, p_chat_id: chatId,
      } as never);
      if (erasureError) throw new Error(`history_erasure_check_${erasureError.code}`);
      if (erased) {
        progress = { ...progress, chat_offset: progress.chat_offset + 1, message_offset: 0 };
        await persistCursor();
        continue;
      }
      const { data: contactId, error: contactError } = await admin.rpc("fn_upsert_wa_contact" as never, {
        p_org: org, p_kind: identity.kind,
        p_phone: identity.kind === "phone" ? canonicalPhoneBR(identity.value) : null,
        p_lid: identity.kind === "lid" ? identity.value : null,
        p_chat_id: chatId, p_notify: typeof chats[0]!.name === "string" ? chats[0]!.name.slice(0, 100) : null,
      } as never);
      if (contactError || !contactId) throw new Error("history_contact_upsert");
      const { data: contact } = await admin.from("contacts").select("is_anonymized")
        .eq("organization_id", org).eq("id", contactId as string).single();
      if (!contact || contact.is_anonymized) {
        progress = { ...progress, chat_offset: progress.chat_offset + 1, message_offset: 0 };
        await persistCursor();
        continue;
      }
      const rows = await waha.listHistoryMessages(session.waha_session_name, chatId, progress.message_offset, MESSAGES_PER_STEP);
      const values = rows.flatMap((row) => {
        const body = row.body?.trim(); const sentAt = historySentAt(row.timestamp);
        if (!body || !sentAt || !row.id || body.length > 10_000) return [];
        return [{ organization_id: org, channel_session_id: sid, contact_id: contactId as string,
          chat_id: chatId, external_id: row.id, direction: row.fromMe ? "outbound" : "inbound",
          body, sent_at: sentAt }];
      });
      let insertedPage = 0;
      if (values.length) {
        const { data: written, error: writeError } = await admin.from("whatsapp_history_messages" as never)
          .upsert(values as never, { onConflict: "organization_id,channel_session_id,external_id", ignoreDuplicates: true })
          .select("id");
        if (writeError) throw new Error(`history_write_${writeError.code}`);
        insertedPage = written?.length ?? 0;
        inserted += insertedPage;
      }
      // A API avisa que uma página pode voltar com menos que o limite mesmo
      // quando há mais mensagens. Só página VAZIA encerra este chat.
      progress = rows.length === 0
        ? { ...progress, chat_offset: progress.chat_offset + 1, message_offset: 0,
            chats_imported: progress.chats_imported + (progress.scan_pass === 0 ? 1 : 0) }
        : { ...progress, message_offset: progress.message_offset + MESSAGES_PER_STEP };
      progress.messages_imported += insertedPage;
      // Cursor persistido a cada página: timeout no próximo chat não refaz trabalho.
      await persistCursor();
    }
    if (progress.status === "complete") await admin.from("whatsapp_history_syncs" as never)
      .upsert({ ...progress, finished_at: new Date().toISOString(), error_code: null, updated_at: new Date().toISOString() } as never);
    return inserted;
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 80) : "history_unknown";
    await admin.from("whatsapp_history_syncs" as never).upsert({ ...progress,
      status: "failed", error_code: code, updated_at: new Date().toISOString(),
    } as never);
    return null;
  }
}
