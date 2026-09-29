import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpContext } from "@/lib/mcp/types";

const handlers = vi.hoisted(() => ({
  listLeadsHandler: vi.fn(),
  getLeadHandler: vi.fn(),
  createLeadHandler: vi.fn(),
  updateLeadHandler: vi.fn(),
  moveLeadHandler: vi.fn(),
}));
vi.mock("@/app/api/v1/leads/_handler", () => handlers);
const { crmCreateLead, crmUpdateLead, crmMoveLeadStage } = await import("@/lib/mcp/tools/leads");

const USER = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const STAGE = "33333333-3333-4333-8333-333333333333";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const PIPELINE = "55555555-5555-4555-8555-555555555555";
const OPERATION = "66666666-6666-4666-8666-666666666666";

function context(
  options: {
    owner?: string | null;
    contact?: boolean;
    member?: boolean;
    revokedMember?: boolean;
    legacy?: boolean;
  } = {},
) {
  const reads: { table: string; filters: [string, unknown][] }[] = [];
  const ctx = {
    connectionId: options.legacy ? undefined : "connection",
    userId: USER,
    organizationId: "own-org",
    role: "agent",
    actor: { type: "user", id: USER, role: "agent" },
    apiTokenId: "token",
    requestId: "request",
    supabase: {
      from(table: string) {
        const filters: [string, unknown][] = [];
        reads.push({ table, filters });
        const query = {
          select() {
            return query;
          },
          eq(key: string, value: unknown) {
            filters.push([key, value]);
            return query;
          },
          is(key: string, value: unknown) {
            filters.push([key, value]);
            return query;
          },
          async maybeSingle() {
            const data =
              table === "organizations"
                ? { settings: { visibility_mode: "own" } }
                : table === "crm_leads"
                  ? { owner_user_id: options.owner === undefined ? USER : options.owner }
                  : table === "contacts"
                    ? options.contact === false
                      ? null
                      : { id: CONTACT }
                    : options.member === false ||
                        (options.revokedMember &&
                          filters.some(([key, value]) => key === "revoked_at" && value === null))
                      ? null
                      : { user_id: USER };
            return { data, error: null };
          },
        };
        return query;
      },
    },
  } as unknown as McpContext;
  return { ctx, reads };
}

describe("personal CRM writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.createLeadHandler.mockResolvedValue({ id: LEAD });
    handlers.updateLeadHandler.mockResolvedValue({ id: LEAD });
    handlers.moveLeadHandler.mockResolvedValue({ id: LEAD });
  });
  it("refuses edits and stage moves on a lead hidden from the connection owner", async () => {
    const { ctx } = context({ owner: "other-user" });
    await expect(crmUpdateLead.handler({ lead_id: LEAD, title: "Changed" }, ctx)).rejects.toThrow(
      "sem acesso",
    );
    await expect(
      crmMoveLeadStage.handler({ lead_id: LEAD, to_stage_id: STAGE }, ctx),
    ).rejects.toThrow("sem acesso");
    expect(handlers.updateLeadHandler).not.toHaveBeenCalled();
    expect(handlers.moveLeadHandler).not.toHaveBeenCalled();
  });
  it("allows an owned lead and binds the preflight lookup to the trusted tenant", async () => {
    const { ctx, reads } = context();
    await crmUpdateLead.handler({ lead_id: LEAD, title: "Qualified" }, ctx);
    await crmMoveLeadStage.handler({ lead_id: LEAD, to_stage_id: STAGE }, ctx);
    expect(handlers.updateLeadHandler).toHaveBeenCalledOnce();
    expect(handlers.moveLeadHandler).toHaveBeenCalledOnce();
    for (const query of reads.filter((read) => read.table === "crm_leads")) {
      expect(query.filters).toContainEqual(["organization_id", "own-org"]);
      expect(query.filters).toContainEqual(["id", LEAD]);
    }
  });
  it("refuses a contact outside the tenant before creating or linking a lead", async () => {
    const { ctx, reads } = context({ contact: false });
    await expect(
      crmCreateLead.handler(
        { pipeline_id: PIPELINE, stage_id: STAGE, title: "New lead", contact_id: CONTACT },
        ctx,
      ),
    ).rejects.toThrow("Contato não encontrado");
    await expect(
      crmUpdateLead.handler({ lead_id: LEAD, contact_id: CONTACT }, ctx),
    ).rejects.toThrow("Contato não encontrado");
    expect(handlers.createLeadHandler).not.toHaveBeenCalled();
    expect(handlers.updateLeadHandler).not.toHaveBeenCalled();
    expect(reads.find((read) => read.table === "contacts")?.filters).toContainEqual([
      "organization_id",
      "own-org",
    ]);
  });
  it("refuses assigning a lead to a person outside the tenant", async () => {
    const { ctx } = context({ member: false });
    await expect(
      crmUpdateLead.handler({ lead_id: LEAD, owner_user_id: USER }, ctx),
    ).rejects.toThrow("Responsável não encontrado");
    expect(handlers.updateLeadHandler).not.toHaveBeenCalled();
  });
  it("refuses a revoked owner membership before approval and before updating", async () => {
    const { ctx, reads } = context({ revokedMember: true });
    const input = { lead_id: LEAD, owner_user_id: USER, operation_id: OPERATION };
    await expect(crmUpdateLead.validateBeforeApproval!(input, ctx)).rejects.toThrow(
      "Responsável não encontrado",
    );
    await expect(crmUpdateLead.handler(input, ctx)).rejects.toThrow(
      "Responsável não encontrado",
    );
    expect(handlers.updateLeadHandler).not.toHaveBeenCalled();
    for (const query of reads.filter((read) => read.table === "user_organizations")) {
      expect(query.filters).toContainEqual(["organization_id", "own-org"]);
      expect(query.filters).toContainEqual(["user_id", USER]);
      expect(query.filters).toContainEqual(["revoked_at", null]);
    }
  });
  it("keeps legacy tokens on the existing shared handler path", async () => {
    const { ctx, reads } = context({ legacy: true });
    await crmUpdateLead.handler({ lead_id: LEAD, title: "Legacy" }, ctx);
    expect(reads).toEqual([]);
    expect(handlers.updateLeadHandler).toHaveBeenCalledOnce();
  });
  it("rejects a missing operation identifier and hidden resources before requesting approval", async () => {
    const { ctx } = context({ owner: "other-user" });
    await expect(
      crmUpdateLead.validateBeforeApproval!({ lead_id: LEAD, title: "Changed" }, ctx),
    ).rejects.toThrow("operation_id");
    await expect(
      crmUpdateLead.validateBeforeApproval!(
        { lead_id: LEAD, operation_id: OPERATION, title: "Changed" },
        ctx,
      ),
    ).rejects.toThrow("sem acesso");
    expect(handlers.updateLeadHandler).not.toHaveBeenCalled();
  });
  it("never forwards the approval identifier as a field patch or lead creation data", async () => {
    const { ctx } = context();
    await crmUpdateLead.handler({ lead_id: LEAD, operation_id: OPERATION, title: "Changed" }, ctx);
    const updateCall = handlers.updateLeadHandler.mock.calls[0];
    expect(updateCall).toBeDefined();
    if (!updateCall) throw new Error("Expected a lead update");
    const patch = updateCall[3];
    expect(patch).toEqual({ title: "Changed" });
    await crmCreateLead.handler(
      { pipeline_id: PIPELINE, stage_id: STAGE, title: "New lead", operation_id: OPERATION },
      ctx,
    );
    const createCall = handlers.createLeadHandler.mock.calls[0];
    expect(createCall).toBeDefined();
    if (!createCall) throw new Error("Expected a lead creation");
    expect(createCall[2]).not.toHaveProperty("operation_id");
  });
});
