import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  progress: null as Record<string, unknown> | null,
  written: [] as Array<Record<string, unknown>>,
  messageOffsets: [] as number[],
  chatOffsets: [] as number[],
  erased: false,
  contactsCreated: 0,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "channel_sessions") return {
        select: () => ({ eq: () => ({ is: () => ({ not: () => ({ data: [{
          id: "session-1", organization_id: "org-1", waha_session_name: "wa-1", status: "WORKING",
        }], error: null }) }) }) }),
      };
      if (table === "whatsapp_history_syncs") return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.progress, error: null }) }) }) }),
        upsert: async (value: Record<string, unknown>) => { state.progress = { ...value }; return { error: null }; },
      };
      if (table === "contacts") return {
        select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { is_anonymized: false } }) }) }) }),
      };
      if (table === "whatsapp_history_messages") return {
        upsert: (rows: Array<Record<string, unknown>>) => ({
          select: async () => {
            state.written.push(...rows);
            return { data: rows.map((_, i) => ({ id: String(i) })), error: null };
          },
        }),
      };
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string) => {
      if (name === "fn_whatsapp_history_chat_erased") return { data: state.erased, error: null };
      state.contactsCreated++;
      return { data: "contact-1", error: null };
    },
  }),
}));

vi.mock("@/lib/waha/client", () => ({
  getWahaClient: () => ({
    getVerifiedSession: async () => ({ status: "WORKING", config: { noweb: { store: { enabled: true } } } }),
    listHistoryChats: async (_session: string, offset: number) => {
      state.chatOffsets.push(offset);
      return offset === 0 ? [{ id: "5511999999999@c.us", name: "Cliente" }] : [];
    },
    listHistoryMessages: async (_session: string, _chat: string, offset: number) => {
      state.messageOffsets.push(offset);
      if (offset === 0) return [{ id: "old-1", body: "Primeira", fromMe: false, timestamp: 1_700_000_000 }];
      if (offset === 100) return [{ id: "old-2", body: "Segunda", fromMe: true, timestamp: 1_700_000_001 }];
      return [];
    },
  }),
}));

import { syncWhatsappHistory } from "./whatsapp-history";

describe("importação paginada do WhatsApp", () => {
  beforeEach(() => {
    state.progress = null;
    state.written = [];
    state.messageOffsets = [];
    state.chatOffsets = [];
    state.erased = false;
    state.contactsCreated = 0;
  });

  it("continua após página curta e conclui apenas na página vazia, sem escrever na timeline ao vivo", async () => {
    expect(await syncWhatsappHistory()).toEqual({ sessions: 1, messages: 2, failures: 0 });
    expect(state.messageOffsets).toEqual([0, 100, 200]);
    expect(state.chatOffsets).toEqual([0, 0, 0, 1]);
    expect(state.written.map((row) => row.external_id)).toEqual(["old-1", "old-2"]);
    expect(state.progress).toMatchObject({ status: "complete", chats_imported: 1, messages_imported: 2 });
  });

  it("não recria contato nem mensagens de chat apagado", async () => {
    state.erased = true;
    expect(await syncWhatsappHistory()).toEqual({ sessions: 1, messages: 0, failures: 0 });
    expect(state.contactsCreated).toBe(0);
    expect(state.messageOffsets).toEqual([]);
    expect(state.written).toEqual([]);
  });
});
