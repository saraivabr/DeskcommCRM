// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { versionCreateSchema } from "@/lib/ai/agents/validation";
const mocks = vi.hoisted(() => ({ create: vi.fn(), publish: vi.fn(), model: vi.fn() }));
vi.mock("@/lib/ai/agents/create-draft", () => ({ createMcpAgentDraft: mocks.create }));
vi.mock("@/lib/ai/agents/publish", () => ({ publishAgentVersionWithClient: mocks.publish }));
vi.mock("@/lib/prospecting/agent-setup", () => ({
  resolveSetupModel: mocks.model,
  AgentSetupError: class AgentSetupError extends Error {},
}));
import {
  ensureStandardProspectingSeller,
  loadStandardSellerProfile,
  saveStandardSellerProfile,
  standardProspectingSellerId,
  standardProspectingSellerPrompt,
} from "@/lib/prospecting/default-seller";

const org = "10000000-0000-4000-8000-000000000001";
const channel = "10000000-0000-4000-8000-000000000002";
const pipeline = "10000000-0000-4000-8000-000000000003";
const otherPipeline = "10000000-0000-4000-8000-000000000004";
const profile = {
  seller_name: "Sara",
  company_name: "Empresa de exemplo",
  offer: "Organizar o atendimento comercial no WhatsApp",
};
const input = { channel_session_id: channel, pipeline_id: pipeline };
const admin = {} as SupabaseClient;
type Agent = {
  id: string;
  created_by: string;
  published_version_id: string | null;
  archived_at: string | null;
  paused_at: string | null;
  operation_mode: string;
  is_active: boolean;
  config: Record<string, unknown>;
};
function database() {
  const state: {
    agent: Agent | null;
    versions: Record<string, unknown>[];
    settings: Record<string, unknown>;
    orgExists: boolean;
    channelOrg: string;
    pipelines: string[];
    transaction: boolean;
    afterCommit?: () => void;
    failReady: boolean;
  } = {
    agent: null,
    versions: [],
    settings: { llm: { provider: "keep" }, prospecting: { ...profile, other: "keep" } },
    orgExists: true,
    channelOrg: org,
    pipelines: [pipeline, otherPipeline],
    transaction: false,
    failReady: false,
  };
  let snapshot: { agent: Agent | null; versions: Record<string, unknown>[] } | null = null;
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql === "begin") {
        state.transaction = true;
        snapshot = structuredClone({ agent: state.agent, versions: state.versions });
      }
      if (sql === "commit") {
        state.transaction = false;
        snapshot = null;
        const concurrentEdit = state.afterCommit;
        state.afterCommit = undefined;
        concurrentEdit?.();
      }
      if (sql === "rollback") {
        state.transaction = false;
        if (snapshot) Object.assign(state, snapshot);
        snapshot = null;
      }
      if (sql.startsWith("select display_name,settings"))
        return {
          rows:
            state.orgExists && params[0] === org
              ? [{ display_name: "Nome cadastrado", prospecting: state.settings.prospecting }]
              : [],
        };
      if (sql.startsWith("update organizations")) {
        if (!state.orgExists || params[0] !== org) return { rows: [] };
        state.settings.prospecting = {
          ...(state.settings.prospecting as Record<string, unknown>),
          ...JSON.parse(params[1] as string),
        };
        return { rows: [{ id: org }] };
      }
      if (sql.startsWith("select id,provider,status"))
        return {
          rows:
            params[0] === state.channelOrg
              ? [{ id: channel, provider: "waha", status: "WORKING" }]
              : [],
        };
      if (sql.startsWith("select id,created_by,published_version_id"))
        return { rows: state.agent && params[0] === org ? [structuredClone(state.agent)] : [] };
      if (sql.startsWith("select coalesce(o.created_by")) return { rows: [{ user_id: org }] };
      if (sql.startsWith("select * from ai_agent_versions"))
        return {
          rows: state.versions.filter(
            (v) =>
              v.id === params[2] &&
              (!sql.includes("status='published'") || v.status === "published"),
          ),
        };
      if (sql.startsWith("select id from ai_agent_versions"))
        return { rows: state.versions.filter((v) => v.status === "draft") };
      if (sql.startsWith("select id from crm_pipelines"))
        return {
          rows: (params[1] as string[])
            .filter((id) => state.pipelines.includes(id))
            .map((id) => ({ id })),
        };
      if (sql.startsWith("select id from ai_knowledge_sources")) return { rows: [] };
      if (sql.startsWith("select coalesce(max"))
        return {
          rows: [
            { version_number: Math.max(0, ...state.versions.map((v) => Number(v.version_number))) },
          ],
        };
      if (sql.startsWith("insert into ai_agent_versions")) {
        const columns = sql.match(/created_by,([^)]*)\)/)![1]!.split(",");
        const version: Record<string, unknown> = {
          id: params[0],
          version_number: params[3],
          status: "draft",
        };
        columns.forEach((name, index) => {
          version[name] = ["followup", "trigger_config"].includes(name)
            ? JSON.parse(params[index + 5] as string)
            : params[index + 5];
        });
        state.versions.push(version);
      }
      if (sql.startsWith("update ai_agents set config=jsonb_set"))
        state.agent!.config.standard_seller_setup = JSON.parse(params[2] as string);
      if (sql.startsWith("update ai_agents set paused_at=case")) {
        if (
          state.failReady ||
          state.agent!.published_version_id !== params[2] ||
          state.agent!.archived_at ||
          (params[3] ? state.agent!.paused_at !== params[3] : state.agent!.paused_at !== null)
        )
          return { rows: [] };
        if (params[3]) state.agent!.paused_at = null;
        delete state.agent!.config.standard_seller_setup;
        return { rows: [{ id: state.agent!.id }] };
      }
      return { rows: [] };
    }),
  };
  mocks.create.mockImplementation(async (_db, context, payload, options) => {
    state.agent = {
      id: options.agentId,
      created_by: context.userId,
      published_version_id: null,
      archived_at: null,
      paused_at: options.pausedAt.toISOString(),
      operation_mode: "automatic",
      is_active: true,
      config: structuredClone(options.config),
    };
    state.versions.push({
      ...structuredClone(payload.version),
      id: options.versionId,
      version_number: 1,
      status: "draft",
    });
    return { agent: structuredClone(state.agent), version: state.versions[0] };
  });
  mocks.publish.mockImplementation(async (client, { versionId }) => {
    expect(client).toBe(db);
    expect(state.transaction).toBe(true);
    expect(db.query.mock.calls.at(-4)?.[0]).toContain("for update");
    state.agent!.published_version_id = versionId;
    for (const version of state.versions)
      version.status = version.id === versionId ? "published" : "superseded";
    return { ok: true };
  });
  return { state, query: db.query, db: db as unknown as pg.PoolClient };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.model.mockResolvedValue({
    provider: "openai",
    model: "configured-model",
    credential_id: null,
  });
});

describe("organization prospecting seller profile", () => {
  it("uses organization identity defaults without creating an agent", async () => {
    const { db, state } = database();
    state.settings.prospecting = undefined;
    expect(await loadStandardSellerProfile(db, org)).toEqual({
      seller_name: "Sara",
      company_name: "Nome cadastrado",
      offer: "",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("updates only the authenticated organization's profile and preserves other settings", async () => {
    const { db, query, state } = database();
    const changed = { ...profile, seller_name: "Marina" };
    expect(await saveStandardSellerProfile(db, org, changed)).toEqual(changed);
    expect(state.settings).toEqual({
      llm: { provider: "keep" },
      prospecting: { ...changed, other: "keep" },
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("jsonb_set"), [
      org,
      JSON.stringify(changed),
    ]);
    await expect(saveStandardSellerProfile(db, channel, changed)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("rejects invalid profile before writing or provisioning", async () => {
    const { db, query, state } = database();
    await expect(
      saveStandardSellerProfile(db, org, { ...profile, offer: "" }),
    ).rejects.toMatchObject({ status: 422 });
    expect(query).not.toHaveBeenCalled();
    state.settings.prospecting = { ...profile, offer: "" };
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toThrow(
      "Salve o nome",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("standard prospecting seller provisioning", () => {
  it("creates and publishes once for the organization, without campaign or message writes", async () => {
    const { db, state, query } = database();
    const first = await ensureStandardProspectingSeller(db, admin, org, input);
    expect(await ensureStandardProspectingSeller(db, admin, org, input)).toEqual(first);
    expect(first.agent_id).toBe(standardProspectingSellerId(org));
    expect(standardProspectingSellerId(channel)).not.toBe(first.agent_id);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(state.agent!.paused_at).toBeNull();
    expect(state.agent!.config).toMatchObject({ managed_by: "prospecting", standard_seller: true });
    expect(
      query.mock.calls.some(([sql]) =>
        /update prospecting_campaigns|insert into messages|ai_router/.test(sql),
      ),
    ).toBe(false);
  });
  it("recovers a failed publication using the same durable draft", async () => {
    const { db, state } = database();
    mocks.publish.mockResolvedValueOnce({ ok: false, code: "credential_missing" });
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
      status: 422,
    });
    const draftId = state.versions[0]!.id;
    expect(state.agent!.paused_at).not.toBeNull();
    await ensureStandardProspectingSeller(db, admin, org, input);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls.map((call) => call[1].versionId)).toEqual([draftId, draftId]);
    expect(state.agent!.paused_at).toBeNull();
  });
  it.each(["paused", "archived", "inactive", "manual"])(
    "does not reactivate a %s seller",
    async (condition) => {
      const { db, state } = database();
      await ensureStandardProspectingSeller(db, admin, org, input);
      if (condition === "paused") state.agent!.paused_at = new Date().toISOString();
      if (condition === "archived") state.agent!.archived_at = new Date().toISOString();
      if (condition === "inactive") state.agent!.is_active = false;
      if (condition === "manual") state.agent!.operation_mode = "manual";
      await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
        status: 409,
      });
      expect(mocks.publish).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves an edited published prompt and model while extending pipeline scope", async () => {
    const { db, state } = database();
    await ensureStandardProspectingSeller(db, admin, org, input);
    state.versions[0]!.system_prompt = "Texto comercial revisado pela equipe da empresa";
    state.versions[0]!.model = "manually-selected-model";
    await ensureStandardProspectingSeller(db, admin, org, { ...input, pipeline_id: otherPipeline });
    expect(state.versions).toHaveLength(2);
    const next = state.versions[1]!;
    expect(next.system_prompt).toBe(state.versions[0]!.system_prompt);
    expect(next.model).toBe("manually-selected-model");
    expect(next.pipeline_ids).toEqual([pipeline, otherPipeline]);
    expect(next.channel_session_id).toBe(channel);
    expect(state.agent!.id).toBe(standardProspectingSellerId(org));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });
  it("refuses manual edits to a draft recovered after publication failure", async () => {
    const { db, state } = database();
    mocks.publish.mockResolvedValueOnce({ ok: false, code: "credential_missing" });
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toThrow();
    state.versions[0]!.system_prompt = "Revisão manual que não deve ser publicada automaticamente";
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite an unrelated draft when a new pipeline is selected", async () => {
    const { db, state } = database();
    await ensureStandardProspectingSeller(db, admin, org, input);
    state.versions.push({ id: org, version_number: 2, status: "draft", system_prompt: "Manual" });
    await expect(
      ensureStandardProspectingSeller(db, admin, org, { ...input, pipeline_id: otherPipeline }),
    ).rejects.toMatchObject({ status: 409 });
    expect(state.versions).toHaveLength(2);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
  it.each(["draft", "base", "pause", "mode", "archive", "marker", "setup", "status"])(
    "rejects a concurrent %s edit committed before phase 2 instead of publishing it",
    async (changed) => {
      const { db, state } = database();
      state.afterCommit = () => {
        if (changed === "draft")
          state.versions[0]!.system_prompt = "Uma revisão externa do texto de vendas";
        if (changed === "base") state.agent!.published_version_id = channel;
        if (changed === "pause") state.agent!.paused_at = "2020-01-01T00:00:00.000Z";
        if (changed === "mode") state.agent!.operation_mode = "manual";
        if (changed === "archive") state.agent!.archived_at = "2020-01-01T00:00:00.000Z";
        if (changed === "marker") state.agent!.config.managed_by = "manual";
        if (changed === "setup") {
          const setup = state.agent!.config.standard_seller_setup as Record<string, unknown>;
          setup.version_hash = "external-change";
        }
        if (changed === "status") state.versions[0]!.status = "superseded";
      };
      await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
        status: 409,
      });
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(state.versions[0]!.status).not.toBe("published");
      expect(state.agent!.config.standard_seller_setup).toBeDefined();
    },
  );
  it("rolls back publication when ready fails, then retries the same durable draft", async () => {
    const { db, state } = database();
    state.failReady = true;
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
      status: 409,
    });
    const draftId = state.versions[0]!.id;
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]!.status).toBe("draft");
    expect(state.agent!.published_version_id).toBeNull();
    expect(state.agent!.paused_at).not.toBeNull();
    state.failReady = false;
    await ensureStandardProspectingSeller(db, admin, org, input);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.publish.mock.calls.map((call) => call[1].versionId)).toEqual([draftId, draftId]);
    expect(state.agent!.paused_at).toBeNull();
    expect(state.agent!.config.standard_seller_setup).toBeUndefined();
  });
  it("validates channel tenancy and propagates the subscription quota without bypass", async () => {
    const { db, state } = database();
    state.channelOrg = channel;
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
      status: 422,
    });
    expect(mocks.create).not.toHaveBeenCalled();
    state.channelOrg = org;
    mocks.create.mockRejectedValueOnce({ code: "P4020" });
    await expect(ensureStandardProspectingSeller(db, admin, org, input)).rejects.toMatchObject({
      status: 409,
    });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("uses a generic commercial persona whose context supplies niche and identity", () => {
    const prompt = standardProspectingSellerPrompt();
    expect(prompt).toContain("nicho do prospect é o público da oferta");
    expect(prompt).not.toContain("clínica");
    expect(prompt).not.toContain("Saraiva");
    expect(prompt).not.toContain("Você é Sara");
    expect(versionCreateSchema.shape.system_prompt.safeParse(prompt).success).toBe(true);
  });
});
