import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "@/lib/event-log/dispatcher";

vi.mock("@/lib/env", () => ({ env: { ANTHROPIC_API_KEY: "test", AI_GATEWAY_API_KEY: "" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/ai/agents/legacy-notice", () => ({ recordLegacyNotice: vi.fn() }));
vi.mock("@/lib/atendimento/origem-mensagem", () => ({ serviceFromMessage: vi.fn(async () => null) }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () => ({ permite: true })),
}));
vi.mock("@/lib/ai/gateway", () => ({
  DEFAULT_BOT_MODEL: "test/model", gatewayConfig: {}, gatewayHeaders: () => ({}),
  isEmbeddingProviderConfigured: () => false,
}));

import { processMessageReceived } from "@/workers/ai-response-worker";
import { createAdminClient } from "@/lib/supabase/admin";
import { serviceFromMessage } from "@/lib/atendimento/origem-mensagem";

type Row = Record<string, unknown>;
const ORG = "organization";
const CONV = "conversation";
const CHANNEL = "channel";
const SELLER = "seller";
const event = {
  organization_id: ORG, entity_id: "message", payload: { message_id: "message", conversation_id: CONV },
} as unknown as EventRow;
const campaign = { organization_id: ORG, config: { agent_id: SELLER, channel_session_id: CHANNEL } };
const candidate: Row = { id: "candidate", organization_id: ORG, conversation_id: CONV, status: "sent", campaign };
const legacy = {
  id: "legacy", organization_id: ORG, config: {}, kind: "rag_bot", is_active: true,
  paused_at: null, archived_at: null, published_version_id: null,
};
const seller = {
  ...legacy, id: SELLER, kind: "mcp_agent", published_version_id: "published",
  operation_mode: "automatic",
  config: { managed_by: "prospecting", standard_seller: true },
};

/** Applies production filters; dropping any tenant/conversation/campaign gate changes the outcome. */
function database(prospect: Row | null, agents: Row[] = [legacy, seller], lookupError = false) {
  const tables: Record<string, Row[]> = {
    conversations: [{
      id: CONV, organization_id: ORG, contact_id: "contact", channel_session_id: CHANNEL,
      last_inbound_at: new Date().toISOString(), contacts: { id: "contact" },
    }],
    messages: [{ id: "message", organization_id: ORG, conversation_id: CONV, body: "Oi", direction: "inbound" }],
    ai_agents: agents,
    prospecting_candidates: prospect ? [prospect] : [],
  };
  const read = (row: Row, path: string): unknown =>
    path.split(/\.|->>/).reduce<unknown>((value, key) =>
      value && typeof value === "object" ? (value as Row)[key] : undefined, row);

  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const result = () => ({ data: rows, error: table === "prospecting_candidates" && lookupError ? { message: "unavailable" } : null });
    const chain = {
      select: () => chain,
      eq: (path: string, value: unknown) => { rows = rows.filter((row) => read(row, path) === value); return chain; },
      is: (path: string, value: unknown) => { rows = rows.filter((row) => (read(row, path) ?? null) === value); return chain; },
      not: (path: string, _operator: string, value: unknown) => { rows = rows.filter((row) => (read(row, path) ?? null) !== value); return chain; },
      in: (path: string, values: unknown[]) => { rows = rows.filter((row) => values.includes(read(row, path))); return chain; },
      order: () => chain,
      limit: (limit: number) => { rows = rows.slice(0, limit); return chain; },
      maybeSingle: async () => ({ ...result(), data: rows[0] ?? null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { from } as unknown as ReturnType<typeof createAdminClient>;
}

beforeEach(() => vi.clearAllMocks());

describe("worker legado cede à vendedora somente na conversa prospectada", () => {
  it.each(["sending", "sent"])("conversa da campanha em %s pertence ao engine", async (status) => {
    vi.mocked(createAdminClient).mockReturnValue(database({ ...candidate, status }));
    expect(await processMessageReceived(event)).toMatchObject({ status: "skipped", reason: "engine_owns_reply" });
    expect(serviceFromMessage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "sem prospecção", prospect: null },
    { name: "outra organização no candidato", prospect: { ...candidate, organization_id: "other" } },
    { name: "outra conversa", prospect: { ...candidate, conversation_id: "other" } },
    { name: "candidato ainda encontrado", prospect: { ...candidate, status: "found" } },
    { name: "candidato com envio falho", prospect: { ...candidate, status: "failed" } },
    { name: "outra organização na campanha", prospect: { ...candidate, campaign: { ...campaign, organization_id: "other" } } },
    { name: "outro canal na campanha", prospect: { ...candidate, campaign: { ...campaign, config: { ...campaign.config, channel_session_id: "other" } } } },
    { name: "outro agente na campanha", prospect: { ...candidate, campaign: { ...campaign, config: { ...campaign.config, agent_id: "other" } } } },
  ])("a vendedora não toma atendimento geral: $name", async ({ prospect }) => {
    vi.mocked(createAdminClient).mockReturnValue(database(prospect));
    // The unrelated service-boundary guard ends this fixture after ownership.
    expect(await processMessageReceived(event)).toMatchObject({ reason: "service_boundary_stale" });
    expect(serviceFromMessage).toHaveBeenCalledTimes(1);
  });

  it("indisponibilidade do lookup não dá atendimento geral à vendedora", async () => {
    vi.mocked(createAdminClient).mockReturnValue(database(candidate, [legacy, seller], true));
    expect(await processMessageReceived(event)).toMatchObject({ reason: "service_boundary_stale" });
  });

  it.each([
    { paused_at: "2026-10-01T00:00:00Z", operation_mode: "automatic" },
    { paused_at: null, operation_mode: "manual" },
  ])("vendedora pausada ou manual não suprime a triagem legada", async (state) => {
    vi.mocked(createAdminClient).mockReturnValue(database(candidate, [legacy, { ...seller, ...state }]));
    expect(await processMessageReceived(event)).toMatchObject({ reason: "service_boundary_stale" });
  });

  it("preserva cessão org-wide quando há outro agente publicado depois da vendedora", async () => {
    vi.mocked(createAdminClient).mockReturnValue(database(null, [legacy, seller, { ...seller, id: "general", config: {} }]));
    expect(await processMessageReceived(event)).toMatchObject({ reason: "engine_owns_reply" });
  });
});
