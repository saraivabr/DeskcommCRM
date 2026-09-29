import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "../types";
import { crmGenerateReplyDraft, crmGetAttendanceContext } from "./atendimento";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  pool: { query: vi.fn() },
  getPool: vi.fn(),
  leadContext: vi.fn(),
  boundary: vi.fn(),
  generate: vi.fn(),
  deps: vi.fn(),
  audit: vi.fn(),
  connection: vi.fn(),
}));
vi.mock("../connections", () => ({ resolveConnection: mocks.connection }));
vi.mock("../resource-access", () => ({ requireConversationAccess: mocks.access }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.getPool }));
vi.mock("@/lib/agent-engine/edge/crm/get-lead-context", () => ({
  getLeadContext: mocks.leadContext,
}));
vi.mock("@/lib/agent-engine/agent/fuso-da-org", () => ({
  fusoDaOrganizacao: async () => "America/Sao_Paulo",
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  readCurrentServiceBoundary: mocks.boundary,
}));
vi.mock("@/lib/agent-engine/agent/reply-drafts", () => ({ generateReplyDraft: mocks.generate }));
vi.mock("@/lib/agent-engine/agent/production-request-deps", () => ({
  productionRequestTurnDeps: mocks.deps,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const USER = "66666666-6666-4666-8666-666666666666";
const GENERATION_INPUT = {
  conversation_id: CONVERSATION,
  expected_reply_context_revision: "12",
  operation_id: DRAFT,
};
const DEMAND = "77777777-7777-4777-8777-777777777777";
const boundary = {
  organization_id: ORG,
  conversation_id: CONVERSATION,
  contact_id: CONTACT,
  service_revision: 3,
  demanda_id: DEMAND,
  demanda_revision: 2,
};
const conversation = {
  id: CONVERSATION,
  contact_id: CONTACT,
  channel_session_id: CHANNEL,
  status: "open",
  is_group: false,
  last_message_at: "2026-09-29T10:00:00Z",
  reply_context_revision: 12,
  service_revision: 3,
  current_demanda_id: DEMAND,
};
const checkpoint = {
  rolling_summary: "Cliente quer entender os valores antes de agendar.",
  commitments: ["Explicar as opções"],
  objections: ["Preço"],
  next_action: "Conferir os horários após a resposta do cliente",
  declaracao: { intencoes: [{ o_que: "quer saber valores", evidencia: "Quanto custa?" }] },
  created_at: new Date("2026-09-29T09:59:00Z"),
};
let contactFlags: { is_blocked: boolean; is_anonymized: boolean };
let conversationData: typeof conversation;
let db: { from: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn> };
let ctx: McpContext;

beforeEach(() => {
  vi.clearAllMocks();
  contactFlags = { is_blocked: false, is_anonymized: false };
  conversationData = { ...conversation };
  const eq = vi.fn();
  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn(() => chain),
      eq,
      maybeSingle: vi.fn(async () => ({
        data: table === "conversations" ? conversationData : { id: CONTACT, ...contactFlags },
        error: null,
      })),
    };
    eq.mockImplementation(() => chain);
    return chain;
  });
  db = { from, eq };
  ctx = {
    connectionId: "connection",
    userId: USER,
    organizationId: ORG,
    role: "agent",
    actor: { type: "user", id: USER, role: "agent" },
    apiTokenId: "token",
    requestId: "request",
    supabase: db,
  } as unknown as McpContext;
  mocks.access.mockResolvedValue(undefined);
  mocks.connection.mockResolvedValue({ connectionId: "connection", userId: USER, role: "agent" });
  mocks.getPool.mockReturnValue(mocks.pool);
  mocks.deps.mockReturnValue({ crmCfg: {}, llmCfg: {} });
  mocks.boundary.mockResolvedValue({ ...boundary, status: "open", demanda_fechada_em: null });
  mocks.leadContext.mockResolvedValue({
    ok: true,
    context: {
      contact: {
        name: "Cliente",
        phone: "private-phone",
        email: "private-email",
        tags: ["interessado"],
        is_blocked: false,
      },
      messages: [
        {
          direction: "inbound",
          body: "Quanto custa?",
          sent_at: "2026-09-29T07:00:00-03:00",
          media_storage_path: "private/path",
        },
      ],
      last_human_decision: { decision: "dismissed", action: "Ligar", at: "2026-09-29T09:00:00Z" },
    },
    lgpd: { isAnonymized: false },
  });
  mocks.pool.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("from lead_checkpoints") ? [checkpoint] : [{ current: true }],
  }));
  mocks.generate.mockResolvedValue({
    id: DRAFT,
    revision: "1",
    status: "pending",
    original_body: "Vamos entender qual opção atende você?",
    proposals: [{ tool: "crm_find_free_slots", arguments: { days: 1 } }],
  });
});

describe("copiloto MCP — guardas antes do pool e da IA", () => {
  for (const tool of [crmGetAttendanceContext, crmGenerateReplyDraft]) {
    it(`${tool.name}: falha de visibilidade não consulta pool nem gera IA`, async () => {
      mocks.access.mockRejectedValue(new Error("Sem acesso"));
      await expect(tool.handler({ ...GENERATION_INPUT, history_limit: 20 }, ctx)).rejects.toThrow(
        "Sem acesso",
      );
      expect(mocks.access).toHaveBeenCalledWith(ctx, CONVERSATION);
      expect(mocks.getPool).not.toHaveBeenCalled();
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(mocks.leadContext).not.toHaveBeenCalled();
    });
    it(`${tool.name}: token legado não alcança o helper`, async () => {
      await expect(
        tool.handler(
          { ...GENERATION_INPUT, history_limit: 20 },
          { ...ctx, connectionId: undefined },
        ),
      ).rejects.toThrow("Conexão pessoal");
      expect(mocks.getPool).not.toHaveBeenCalled();
      expect(mocks.access).not.toHaveBeenCalled();
    });
    for (const flag of ["is_blocked", "is_anonymized"] as const) {
      it(`${tool.name}: contato ${flag} não alcança pool/IA`, async () => {
        contactFlags[flag] = true;
        await expect(tool.handler({ ...GENERATION_INPUT, history_limit: 20 }, ctx)).rejects.toThrow(
          "bloqueado ou anonimizado",
        );
        expect(mocks.getPool).not.toHaveBeenCalled();
        expect(mocks.generate).not.toHaveBeenCalled();
      });
    }
  }
});

describe("crm_get_attendance_context", () => {
  it("filtra todas as leituras pelo tenant e pela fronteira exata, sem expor telefone/email/storage", async () => {
    const result = await crmGetAttendanceContext.handler(
      { ...GENERATION_INPUT, history_limit: 20 },
      ctx,
    );
    expect(db.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(mocks.leadContext).toHaveBeenCalledWith(
      mocks.pool,
      { supabase: db },
      {
        tenantId: ORG,
        leadId: CONTACT,
        conversationId: CONVERSATION,
        fuso: "America/Sao_Paulo",
      },
      { historyLimit: 20, maxTokens: 4000 },
    );
    const [sql, args] = mocks.pool.query.mock.calls[0]!;
    expect(sql).toContain("conversation_id=$3");
    expect(sql).toContain("demanda_revision is not distinct from $6::bigint");
    expect(args).toEqual([ORG, CONTACT, CONVERSATION, 3, DEMAND, 2]);
    expect(result).toMatchObject({
      analysis: {
        availability: "available",
        intentions: [{ o_que: "quer saber valores", evidencia: "Quanto custa?" }],
        next_action: checkpoint.next_action,
      },
      freshness: { context_current: true, analysis_predates_latest_message: true },
      last_human_decision: { decision: "dismissed", action: "Ligar" },
      history_complete: false,
      url: `/app/inbox?id=${CONVERSATION}`,
    });
    expect(JSON.stringify(result)).not.toMatch(/private-phone|private-email|private\/path/);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("mudança de revisão durante a leitura impede devolver contexto misturado", async () => {
    mocks.pool.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("from lead_checkpoints") ? [checkpoint] : [{ current: false }],
    }));
    await expect(
      crmGetAttendanceContext.handler({ ...GENERATION_INPUT, history_limit: 20 }, ctx),
    ).rejects.toThrow("A conversa mudou");
  });
  it("fronteira de outro tenant não lê histórico/checkpoint", async () => {
    mocks.boundary.mockResolvedValue({ ...boundary, organization_id: USER });
    await expect(
      crmGetAttendanceContext.handler({ ...GENERATION_INPUT, history_limit: 20 }, ctx),
    ).rejects.toThrow("A conversa mudou");
    expect(mocks.leadContext).not.toHaveBeenCalled();
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });
  it("ausência de checkpoint é explícita, sem inventar intenção ou próximo passo", async () => {
    mocks.pool.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("from lead_checkpoints") ? [] : [{ current: true }],
    }));
    expect(
      await crmGetAttendanceContext.handler({ ...GENERATION_INPUT, history_limit: 20 }, ctx),
    ).toMatchObject({
      analysis: { availability: "unavailable", summary: null, intentions: null, next_action: null },
    });
  });
  it("ler contexto encerrado não abre novo atendimento", async () => {
    conversationData.status = "closed";
    expect(
      await crmGetAttendanceContext.handler({ ...GENERATION_INPUT, history_limit: 20 }, ctx),
    ).toMatchObject({ conversation: { status: "closed" } });
    expect(
      mocks.pool.query.mock.calls.every(
        (call) => typeof call[0] === "string" && call[0].trim().startsWith("select"),
      ),
    ).toBe(true);
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

describe("crm_generate_reply_draft", () => {
  it("recurso sem acesso é recusado também antes da aprovação, sem pool/IA", async () => {
    mocks.access.mockRejectedValue(new Error("Sem acesso"));
    await expect(
      crmGenerateReplyDraft.validateBeforeApproval!(GENERATION_INPUT, ctx),
    ).rejects.toThrow("Sem acesso");
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("usa geração canônica e devolve análise recém-gerada sem aprovar ou enviar", async () => {
    mocks.generate.mockResolvedValue({
      id: DRAFT,
      revision: "2",
      status: "pending",
      original_body: "Resposta",
      proposals: [],
      preview_checkpoint: {
        rolling_summary: "Análise atual",
        next_action: "Conferir horários",
        commitments: [],
        objections: [],
      },
    });
    const result = await crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx);
    expect(mocks.generate).toHaveBeenCalledWith(mocks.pool, mocks.deps.mock.results[0]!.value, {
      organizationId: ORG,
      conversationId: CONVERSATION,
      contactId: CONTACT,
      channelId: CHANNEL,
      expectedContextRevision: "12",
    });
    expect(result).toMatchObject({
      draft_id: DRAFT,
      status: "pending",
      analysis: {
        availability: "available",
        source: "fresh_preview",
        rolling_summary: "Análise atual",
      },
      sent: false,
      actions_executed: false,
      review_required: true,
      url: `/app/inbox?id=${CONVERSATION}`,
    });
    expect(mocks.pool.query).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER, organizationId: ORG, resourceId: CONVERSATION }),
    );
  });
  it("cache não finge análise recém-gerada e mantém as propostas só como propostas", async () => {
    expect(await crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).toMatchObject({
      analysis: { availability: "unavailable", source: null },
      proposals: [{ tool: "crm_find_free_slots" }],
      actions_executed: false,
    });
  });
  it("rascunho stale continua stale, sem análise disponível", async () => {
    mocks.generate.mockResolvedValue({
      id: DRAFT,
      revision: "1",
      status: "stale",
      original_body: "Texto anterior",
      preview_checkpoint: { rolling_summary: "Não devolver como análise atual" },
    });
    expect(await crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).toMatchObject({
      status: "stale",
      analysis: { availability: "unavailable" },
      review_required: true,
    });
  });
  it("atendimento encerrado falha antes do pool/IA", async () => {
    conversationData.status = "closed";
    await expect(crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).rejects.toThrow(
      "Atendimento encerrado",
    );
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("revisão diferente é recusada antes da aprovação e da geração", async () => {
    const staleInput = { ...GENERATION_INPUT, expected_reply_context_revision: "11" };
    await expect(crmGenerateReplyDraft.validateBeforeApproval!(staleInput, ctx)).rejects.toThrow(
      "A conversa mudou",
    );
    await expect(crmGenerateReplyDraft.handler(staleInput, ctx)).rejects.toThrow(
      "A conversa mudou",
    );
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
  it("revalida conexão, papel e visibilidade depois da IA antes de devolver o corpo", async () => {
    ctx.role = "manager";
    await crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx);
    expect(mocks.connection).toHaveBeenCalledWith("token", ORG, "manager");
    expect(mocks.access).toHaveBeenLastCalledWith(
      expect.objectContaining({ role: "agent" }),
      CONVERSATION,
    );
    expect(mocks.generate.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.connection.mock.invocationCallOrder[0]!,
    );
    expect(mocks.connection.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.audit.mock.invocationCallOrder[0]!,
    );
  });
  for (const flag of ["is_blocked", "is_anonymized"] as const) {
    it(`contato ${flag} durante a IA não libera corpo/propostas nem sucesso na auditoria`, async () => {
      mocks.generate.mockImplementationOnce(async () => {
        contactFlags[flag] = true;
        return {
          id: DRAFT,
          revision: "1",
          status: "pending",
          original_body: "DADO PRIVADO",
          proposals: [{ tool: "crm_update_lead", arguments: { title: "DADO PRIVADO" } }],
        };
      });
      await expect(crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).rejects.toThrow(
        "bloqueado ou anonimizado",
      );
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  }
  it("revisão mudou durante a IA: não libera corpo nem audita sucesso", async () => {
    mocks.generate.mockImplementationOnce(async () => {
      conversationData.reply_context_revision = 13;
      return { id: DRAFT, revision: "1", status: "stale", original_body: "DADO PRIVADO" };
    });
    await expect(crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).rejects.toThrow(
      "A conversa mudou",
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("conversa transferida durante a IA: visibilidade live barra o retorno", async () => {
    mocks.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Sem acesso"));
    await expect(crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).rejects.toThrow(
      "Sem acesso",
    );
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("conexão revogada durante a IA: retorno recusado sem conteúdo", async () => {
    mocks.connection.mockRejectedValueOnce(new Error("Conexão revogada"));
    await expect(crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).rejects.toThrow(
      "Conexão revogada",
    );
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  for (const live of [
    { connectionId: "connection", userId: USER, role: "viewer" },
    { connectionId: "another", userId: USER, role: "agent" },
    { connectionId: "connection", userId: CONTACT, role: "agent" },
  ]) {
    it(`identidade/papel live incompatível ${JSON.stringify(live)} não libera dados`, async () => {
      mocks.connection.mockResolvedValueOnce(live);
      await expect(crmGenerateReplyDraft.handler(GENERATION_INPUT, ctx)).rejects.toThrow(
        "O acesso ao atendimento mudou",
      );
      expect(mocks.generate).toHaveBeenCalledTimes(1);
      expect(mocks.audit).not.toHaveBeenCalled();
    });
  }
});
