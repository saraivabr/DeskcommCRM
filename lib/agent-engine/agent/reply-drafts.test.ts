import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { InboundTurnDeps } from "./inbound-turn";
import { generateReplyDraft } from "./reply-drafts";

const mocks = vi.hoisted(() => ({
  agent: vi.fn(),
  context: vi.fn(),
  preview: vi.fn(),
  query: vi.fn(),
}));
const DRAFT = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
vi.mock("./agent-config", () => ({ loadConversationAgentConfig: mocks.agent }));
vi.mock("../edge/crm/get-lead-context", () => ({ getLeadContext: mocks.context }));
vi.mock("./fuso-da-org", () => ({ fusoDaOrganizacao: async () => "America/Sao_Paulo" }));
vi.mock("./preview", () => ({
  newPreviewResult: () => ({ candidates: [], proposals: [], impediments: [], restrictions: [] }),
}));
vi.mock("./inbound-turn", async () => {
  const { z } = await import("zod");
  return {
    latestCheckpoint: async () => null,
    runAgentPreview: mocks.preview,
    checkpointContentSchema: z.object({
      rolling_summary: z.string(),
      commitments: z.array(z.string()),
      objections: z.array(z.string()),
      next_action: z.string().nullable(),
    }),
  };
});
vi.mock("@/lib/atendimento/fronteira", () => ({
  parseServiceBoundary: (b: unknown) => b,
  assertCurrentServiceBoundary: vi.fn(),
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  readCurrentServiceBoundary: async () => ({ service_revision: 1 }),
  withServiceBoundary: async (_pool: unknown, _boundary: unknown, action: () => Promise<unknown>) =>
    action(),
}));
const pool = { query: mocks.query } as unknown as pg.Pool;
const deps = { crmCfg: {} } as InboundTurnDeps;
const input = {
  organizationId: "org",
  conversationId: "conversation",
  contactId: "contact",
  channelId: "channel",
};
let draftStatus: string;
let savedStatus: string;
let generationToken: string;
const checkpoint = {
  rolling_summary: "Resumo da prévia",
  commitments: ["Confirmar valores"],
  objections: [],
  next_action: "Aguardar escolha do cliente",
};

beforeEach(() => {
  vi.clearAllMocks();
  draftStatus = "generating";
  savedStatus = "pending";
  mocks.agent.mockResolvedValue({
    agentId: "agent",
    versionId: VERSION,
    historyMessageWindow: 20,
    historyTokenWindow: 1000,
  });
  mocks.context.mockResolvedValue({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false },
  });
  mocks.preview.mockImplementation(async (_deps, _pool, preview) => {
    preview.result.candidates.push({ body: "Resposta para revisar", trace: [] });
    preview.result.checkpoint = checkpoint;
  });
  mocks.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("fn_reply_begin")) {
      generationToken = String(args[4]);
      return {
        rows: [
          {
            id: DRAFT,
            status: draftStatus,
            revision: "1",
            context_revision: "12",
            generation_token: draftStatus === "generating" ? generationToken : VERSION,
            original_body: "Cache",
            agent_version_id: VERSION,
            service_boundary: {},
          },
        ],
      };
    }
    if (sql.startsWith("update ai_reply_drafts set status=case"))
      return {
        rows: [
          {
            id: DRAFT,
            status: savedStatus,
            revision: "1",
            generation_token: generationToken,
            original_body: "Resposta para revisar",
            agent_version_id: VERSION,
            service_boundary: {},
          },
        ],
      };
    return { rows: [] };
  });
});

describe("generateReplyDraft — análise da prévia", () => {
  it("devolve checkpoint recém-gerado sem gravar checkpoint operacional", async () => {
    const result = await generateReplyDraft(pool, deps, input);
    expect(result).toMatchObject({
      status: "pending",
      original_body: "Resposta para revisar",
      preview_checkpoint: checkpoint,
    });
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(
      mocks.query.mock.calls.every(
        (call) => typeof call[0] === "string" && !call[0].includes("insert into lead_checkpoints"),
      ),
    ).toBe(true);
  });
  it("cache deduplicado não roda outra geração nem inventa análise", async () => {
    draftStatus = "pending";
    const result = await generateReplyDraft(pool, deps, input);
    expect(result).toMatchObject({ status: "pending", original_body: "Cache" });
    expect(result).not.toHaveProperty("preview_checkpoint");
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it("contexto mudou durante geração: resultado stale não expõe a análise como atual", async () => {
    savedStatus = "stale";
    const result = await generateReplyDraft(pool, deps, input);
    expect(result.status).toBe("stale");
    expect(result).not.toHaveProperty("preview_checkpoint");
  });
  it("contato bloqueado não alcança a prévia e marca falha no rascunho", async () => {
    mocks.context.mockResolvedValue({
      ok: true,
      context: { contact: { is_blocked: true } },
      lgpd: { isAnonymized: false },
    });
    await expect(generateReplyDraft(pool, deps, input)).rejects.toThrow(
      "reply_context_unavailable",
    );
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("set status='failed'"), [
      "org",
      DRAFT,
      generationToken,
    ]);
  });
  it("mensagem nova entre aprovação e begin falha sem IA, marcando só a geração própria stale", async () => {
    await expect(
      generateReplyDraft(pool, deps, { ...input, expectedContextRevision: "11" }),
    ).rejects.toThrow("reply_context_stale");
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("set status='stale'"), [
      "org",
      DRAFT,
      generationToken,
    ]);
  });
});
