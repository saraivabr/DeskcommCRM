import { describe, expect, it, vi } from "vitest";
import { withActionApproval } from "@/lib/mcp/approvals";
import { crmUpdateLead } from "@/lib/mcp/tools/leads";
import { crmBookAppointment } from "@/lib/mcp/tools/agendamento";
import type { McpContext } from "@/lib/mcp/types";
const OPERATION = "11111111-1111-4111-8111-111111111111";
const NEXT_OPERATION = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const rows: Record<string, unknown>[] = [];
  const ctx = {
    connectionId: "connection",
    organizationId: "org",
    userId: "user",
    supabase: {
      from() {
        let insert: Record<string, unknown> | undefined;
        let update: Record<string, unknown> | undefined;
        const filters: ((row: Record<string, unknown>) => boolean)[] = [];
        async function run() {
          if (insert) {
            const row = {
              id: `approval-${rows.length}`,
              status: "pending",
              expires_at: new Date(Date.now() + 900_000).toISOString(),
              ...insert,
            };
            rows.push(row);
            return { data: row, error: null };
          }
          const row = rows
            .filter((candidate) => filters.every((filter) => filter(candidate)))
            .at(-1);
          if (row && update) Object.assign(row, update);
          return { data: row ?? null, error: null };
        }
        const query = {
          select() {
            return query;
          },
          insert(value: Record<string, unknown>) {
            insert = value;
            return query;
          },
          update(value: Record<string, unknown>) {
            update = value;
            return query;
          },
          eq(key: string, value: unknown) {
            filters.push((row) => row[key] === value);
            return query;
          },
          gt(key: string, value: string) {
            filters.push((row) => String(row[key]) > value);
            return query;
          },
          in(key: string, values: unknown[]) {
            filters.push((row) => values.includes(row[key]));
            return query;
          },
          order() {
            return query;
          },
          limit() {
            return query;
          },
          maybeSingle: run,
          single: run,
          then(resolve: (value: unknown) => unknown) {
            return run().then(resolve);
          },
        };
        return query;
      },
    },
  } as unknown as McpContext;
  function approval(index = 0) {
    const row = rows[index];
    expect(row).toBeDefined();
    if (!row) throw new Error("Expected an approval record");
    return row;
  }
  return { ctx, rows, approval };
}

describe("personal CRM and agenda approvals", () => {
  it("writes only after the exact request is approved, once, and returns its saved result on retry", async () => {
    const { ctx, approval } = fixture();
    const args = { lead_id: "lead", title: "Qualified", operation_id: OPERATION };
    const execute = vi.fn().mockResolvedValue({ lead: { id: "lead", title: "Qualified" } });
    expect(await withActionApproval(crmUpdateLead, args, ctx, execute)).toMatchObject({
      status: "confirmation_required",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(approval()).toMatchObject({
      user_id: "user",
      connection_id: "connection",
      organization_id: "org",
      args,
    });
    approval().status = "approved";
    const result = await withActionApproval(crmUpdateLead, args, ctx, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(await withActionApproval(crmUpdateLead, args, ctx, execute)).toEqual(result);
    expect(execute).toHaveBeenCalledOnce();
    expect(
      await withActionApproval(
        crmUpdateLead,
        { ...args, operation_id: NEXT_OPERATION },
        ctx,
        execute,
      ),
    ).toMatchObject({ status: "confirmation_required" });
    approval(1).status = "approved";
    await withActionApproval(
      crmUpdateLead,
      { ...args, operation_id: NEXT_OPERATION },
      ctx,
      execute,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      await withActionApproval(crmUpdateLead, { ...args, title: "Changed again" }, ctx, execute),
    ).toMatchObject({ status: "confirmation_required" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("requires confirmation before reserving a client's appointment", async () => {
    const { ctx, rows } = fixture();
    const execute = vi.fn().mockResolvedValue({ marcado: true });
    expect(
      await withActionApproval(
        crmBookAppointment,
        { contact_id: "contact", starts_at: "2026-10-01T14:00:00Z" },
        ctx,
        execute,
      ),
    ).toMatchObject({ status: "confirmation_required" });
    expect(rows).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not repeat a refused or failed operation", async () => {
    const { ctx, approval } = fixture();
    const args = { lead_id: "lead", title: "Changed" };
    const execute = vi.fn().mockRejectedValue(new Error("write timeout"));
    await withActionApproval(crmUpdateLead, args, ctx, execute);
    approval().status = "rejected";
    expect(await withActionApproval(crmUpdateLead, args, ctx, execute)).toMatchObject({
      status: "rejected",
    });
    expect(execute).not.toHaveBeenCalled();
    approval().status = "approved";
    await expect(withActionApproval(crmUpdateLead, args, ctx, execute)).rejects.toThrow("timeout");
    expect(await withActionApproval(crmUpdateLead, args, ctx, execute)).toMatchObject({
      status: "failed",
    });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("requires a fresh decision when the approval expired", async () => {
    const { ctx, rows, approval } = fixture();
    const args = { lead_id: "lead", title: "Changed" };
    const execute = vi.fn();
    await withActionApproval(crmUpdateLead, args, ctx, execute);
    approval().status = "approved";
    approval().expires_at = "2020-01-01T00:00:00Z";
    expect(await withActionApproval(crmUpdateLead, args, ctx, execute)).toMatchObject({
      status: "confirmation_required",
    });
    expect(rows).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });
  it("preserves the legacy MCP execution path", async () => {
    const { ctx, rows } = fixture();
    delete ctx.connectionId;
    const execute = vi.fn().mockResolvedValue({ lead: { id: "lead" } });
    await withActionApproval(crmUpdateLead, { lead_id: "lead" }, ctx, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(rows).toEqual([]);
  });
});
