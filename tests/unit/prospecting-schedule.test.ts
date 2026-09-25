import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  activate: vi.fn(),
  credential: vi.fn(),
  validate: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/prospecting/store", () => ({
  withProspectingLock: async (pool: unknown, _org: string, fn: (db: unknown) => unknown) =>
    fn(pool),
  createSearchWithClient: mocks.create,
  activateCampaignWithClient: mocks.activate,
  credential: mocks.credential,
  validateConfig: mocks.validate,
}));
import {
  hasSearchBudget,
  tickSchedules,
  saveSchedule,
  stopSchedule,
} from "@/lib/prospecting/schedule";
import { scheduleConfigSchema } from "@/lib/prospecting/schema";
const config = scheduleConfigSchema.parse({
  search: {
    source: "instagram",
    name: "Teste",
    niche: "Teste",
    location: "SP",
    budget_usd: 1,
    limit: 5,
  },
  interval_hours: 24,
  max_runs: 2,
  total_budget_usd: 2,
  campaign_config: null,
});
let row: Record<string, unknown>;
let campaign: Record<string, unknown> | null;
let query: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  row = {
    organization_id: "org",
    schedule_config: config,
    schedule_enabled: true,
    schedule_runs: 0,
    schedule_reserved_usd: "0",
    schedule_next_at: null,
    schedule_request_id: null,
    schedule_campaign_id: null,
  };
  campaign = null;
  query = vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql.startsWith("select organization_id from prospecting_settings"))
      return { rows: row.schedule_enabled ? [{ organization_id: "org" }] : [] };
    if (sql.startsWith("select * from prospecting_settings")) return { rows: [{ ...row }] };
    if (sql.startsWith("select * from prospecting_campaigns"))
      return { rows: campaign ? [campaign] : [] };
    if (sql.startsWith("select 1 from prospecting_campaigns")) return { rows: [] };
    if (sql.includes("set schedule_request_id=$2")) {
      row.schedule_request_id = args?.[1];
      row.schedule_runs = Number(row.schedule_runs) + 1;
      row.schedule_reserved_usd = String(Number(row.schedule_reserved_usd) + 1);
      return { rows: [{ organization_id: "org" }] };
    }
    if (sql.includes("set schedule_campaign_id=$2")) row.schedule_campaign_id = args?.[1];
    if (sql.includes("set schedule_enabled=false,schedule_error=$2")) row.schedule_enabled = false;
    return { rows: [] };
  });
  mocks.create.mockResolvedValue({ id: "campaign", search_status: "running" });
  mocks.credential.mockResolvedValue("dummy");
  mocks.audit.mockResolvedValue(undefined);
});
it("disabled recurrence makes no search or contact calls", async () => {
  row.schedule_enabled = false;
  expect(await tickSchedules({ query } as never, {} as never)).toBe(0);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.activate).not.toHaveBeenCalled();
});
it("reserves the ceiling durably before requesting a paid run", async () => {
  mocks.create.mockImplementation(async (_db, _admin, org, id) => {
    expect(org).toBe("org");
    expect(id).toBe(row.schedule_request_id);
    expect(row.schedule_reserved_usd).toBe("1");
    expect(row.schedule_runs).toBe(1);
    return { id: "campaign", search_status: "running" };
  });
  await tickSchedules({ query } as never, {} as never);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(row.schedule_campaign_id).toBe("campaign");
});
it("reuses the reserved request identity after interruption without reserving again", async () => {
  row.schedule_request_id = "stable";
  row.schedule_runs = 1;
  row.schedule_reserved_usd = "1";
  await tickSchedules({ query } as never, {} as never);
  expect(mocks.create.mock.calls[0]?.[3]).toBe("stable");
  expect(row.schedule_runs).toBe(1);
});
it("stops after an uncertain response and never retries its paid POST", async () => {
  mocks.create.mockResolvedValue({ id: "campaign", search_status: "unknown" });
  await tickSchedules({ query } as never, {} as never);
  await tickSchedules({ query } as never, {} as never);
  expect(row.schedule_enabled).toBe(false);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it.each([
  { schedule_runs: 2 },
  { schedule_reserved_usd: "2" },
  { schedule_next_at: "2999-01-01T00:00:00Z" },
])("does not spend beyond quota or before frequency: %j", async (patch) => {
  Object.assign(row, patch);
  await tickSchedules({ query } as never, {} as never);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("stops instead of repeatedly paying for an exhausted audience", async () => {
  row.schedule_campaign_id = "campaign";
  campaign = { id: "campaign", search_status: "succeeded", status: "draft" };
  await tickSchedules({ query } as never, {} as never);
  expect(row.schedule_enabled).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("hands a completed search to the existing guarded activation path", async () => {
  const cfg = {
    agent_id: "a",
    channel_session_id: "c",
    pipeline_id: "p",
    stage_id: "s",
    qualified_stage_id: "q",
    instruction: "Converse sobre necessidade",
    qualification: "Solicitou demonstração",
    legal_basis_ref: "Registro avaliado",
    daily_limit: 5,
    interval_minutes: 15,
  };
  const ids = [
    "agent_id",
    "channel_session_id",
    "pipeline_id",
    "stage_id",
    "qualified_stage_id",
  ] as const;
  for (const k of ids) cfg[k] = "11111111-1111-4111-8111-111111111111";
  row.schedule_config = { ...config, campaign_config: cfg };
  row.schedule_campaign_id = "campaign";
  campaign = { id: "campaign", search_status: "succeeded", status: "draft" };
  await tickSchedules({ query } as never, {} as never);
  expect(mocks.activate).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "org",
    "campaign",
    cfg,
    true,
  );
  expect(mocks.create).not.toHaveBeenCalled();
});
it("saving always persists disabled and does not call the provider", async () => {
  query
    .mockResolvedValue({ rows: [{ organization_id: "org" }] })
    .mockResolvedValueOnce({ rows: [] });
  await saveSchedule({ query } as never, "org", config);
  expect(query.mock.calls[1]?.[0]).toContain("schedule_enabled=false");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("stop disables recurrence and pauses the associated campaign together", async () => {
  await stopSchedule({ query } as never, "org");
  expect(query.mock.calls[0]?.[0]).toContain("status='paused'");
  expect(query.mock.calls[0]?.[1]).toEqual(["org"]);
});
it("validates cost precision, frequency and total ceiling", () => {
  expect(hasSearchBudget(config, 1, 1)).toBe(true);
  expect(hasSearchBudget(config, 2, 1)).toBe(false);
  expect(scheduleConfigSchema.safeParse({ ...config, interval_hours: 1 }).success).toBe(false);
  expect(scheduleConfigSchema.safeParse({ ...config, total_budget_usd: 0.5 }).success).toBe(false);
  expect(scheduleConfigSchema.safeParse({ ...config, total_budget_usd: 1.001 }).success).toBe(
    false,
  );
});
