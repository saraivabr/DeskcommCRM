// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  profile: vi.fn(),
  router: vi.fn(),
  bound: vi.fn(),
  contact: vi.fn(),
  lead: vi.fn(),
  origin: vi.fn(),
}));
vi.mock("@/lib/prospecting/default-seller", () => ({
  ensureStandardProspectingSeller: mocks.ensure,
  loadStandardSellerProfile: mocks.profile,
  standardProspectingSellerId: () => "55555555-5555-4555-8555-555555555555",
}));
vi.mock("@/lib/agent-engine/agent/router-config", () => ({ loadActiveRouter: mocks.router }));
vi.mock("@/lib/agent-engine/agent/agent-config", () => ({ loadPublishedAgentConfig: mocks.bound }));
vi.mock("@/app/api/v1/contacts/_handler", () => ({ createContactHandler: mocks.contact }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: mocks.lead }));
vi.mock("@/lib/atendimento/origem", () => ({ beginServiceAtOrigin: mocks.origin }));
import { activateCampaignWithClient, resolveCampaignConfig } from "@/lib/prospecting/store";
import { campaignConfigSchema } from "@/lib/prospecting/schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENT = "55555555-5555-4555-8555-555555555555";
const profile = {
  seller_name: "Sara",
  company_name: "Saraiva.AI",
  offer: "Organizamos o atendimento e o retorno aos interessados.",
};
const input = {
  channel_session_id: "22222222-2222-4222-8222-222222222222",
  pipeline_id: "33333333-3333-4333-8333-333333333333",
  stage_id: "44444444-4444-4444-8444-444444444444",
  qualified_stage_id: "44444444-4444-4444-8444-444444444445",
  instruction: profile.offer,
  qualification: "Quer avançar para uma conversa comercial.",
  daily_limit: 10,
  interval_minutes: 15,
  legal_basis_ref: "Avaliação registrada",
};
const admin = {} as never;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profile.mockResolvedValue(profile);
  mocks.ensure.mockResolvedValue({ agent_id: AGENT });
});
function database(campaign: Record<string, unknown>) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.startsWith("select * from prospecting_campaigns")) return { rows: [campaign] };
    if (sql.startsWith("select id from prospecting_campaigns")) return { rows: [] };
    if (sql.startsWith("select v.tool_ids"))
      return {
        rows: [
          {
            tool_ids: ["crm_move_lead_stage"],
            pipeline_ids: [input.pipeline_id],
            config: { managed_by: "prospecting", standard_seller: true },
          },
        ],
      };
    if (sql.startsWith("select provider,status"))
      return { rows: [{ provider: "waha", status: "WORKING" }] };
    if (sql.startsWith("select id from crm_stages"))
      return { rows: [{ id: input.stage_id }, { id: input.qualified_stage_id }] };
    if (sql.includes("returning id")) return { rows: [{ id: campaign.id }] };
    return { rows: [] };
  });
  return { query };
}
describe("standard seller activation boundaries", () => {
  it("resolves the organization profile without a client-selected agent", async () => {
    const db = database({});
    expect(await resolveCampaignConfig(db as never, admin, ORG, input)).toEqual({
      ...input,
      agent_id: AGENT,
      standard_seller: profile,
    });
    expect(mocks.ensure).toHaveBeenCalledWith(db, admin, ORG, input);
  });
  it("rejects an incomplete offer before provisioning", async () => {
    mocks.profile.mockResolvedValue({ ...profile, offer: "" });
    await expect(resolveCampaignConfig(database({}) as never, admin, ORG, input)).rejects.toThrow(
      "Configure o nome",
    );
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("keeps explicit legacy agent configurations", async () => {
    const legacy = { ...input, agent_id: "66666666-6666-4666-8666-666666666666" };
    expect(await resolveCampaignConfig(database({}) as never, admin, ORG, legacy)).toEqual(legacy);
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it.each(["running", "paused"])(
    "does not provision or prepare an already %s campaign",
    async (status) => {
      await expect(
        activateCampaignWithClient(
          database({ id: "batch", status, search_status: "succeeded" }) as never,
          admin,
          ORG,
          "batch",
          input,
        ),
      ).rejects.toThrow("já iniciada");
      expect(mocks.ensure).not.toHaveBeenCalled();
    },
  );
  it("uses the current offer for a new scheduled batch", async () => {
    const current = {
      ...profile,
      seller_name: "Clara",
      offer: "Acompanhamos interessados e organizamos as oportunidades comerciais.",
    };
    mocks.profile.mockResolvedValue(current);
    const db = database({ id: "batch", status: "draft", search_status: "succeeded", config: null });
    await activateCampaignWithClient(db as never, admin, ORG, "batch", input, true);
    const saved = db.query.mock.calls.find(([sql]) =>
      sql.startsWith("update prospecting_campaigns set config=$3 where"),
    );
    expect(saved?.[1]?.[2]).toEqual({
      ...input,
      instruction: current.offer,
      agent_id: AGENT,
      standard_seller: current,
    });
    expect(mocks.router).not.toHaveBeenCalled();
    expect(mocks.bound).not.toHaveBeenCalled();
    expect(mocks.origin).not.toHaveBeenCalled();
  });
  it("keeps the frozen identity and offer on an interrupted scheduled preparation", async () => {
    const frozen = campaignConfigSchema.parse({
      ...input,
      agent_id: AGENT,
      standard_seller: profile,
    });
    mocks.profile.mockResolvedValue({
      ...profile,
      seller_name: "Clara",
      offer: "Oferta nova que só pode entrar em uma próxima campanha.",
    });
    const db = database({
      id: "batch",
      status: "draft",
      search_status: "succeeded",
      config: frozen,
    });
    await activateCampaignWithClient(
      db as never,
      admin,
      ORG,
      "batch",
      { ...input, instruction: "Oferta nova no agendamento" },
      true,
    );
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    const saved = db.query.mock.calls.find(([sql]) =>
      sql.startsWith("update prospecting_campaigns set config=$3 where"),
    );
    expect(saved?.[1]?.[2]).toEqual(frozen);
  });
});
