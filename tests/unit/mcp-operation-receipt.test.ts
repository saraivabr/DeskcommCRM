import { describe, expect, it } from "vitest";
import { withOperationReceipt } from "@/lib/mcp/operation-receipt";
import type { McpContext } from "@/lib/mcp/types";
function fixture() {
  const rows: Record<string, unknown>[] = [];
  let unavailable = false;
  const ctx = {
    connectionId: "connection",
    organizationId: "org",
    supabase: {
      from() {
        let insert: Record<string, unknown> | undefined;
        let update: Record<string, unknown> | undefined;
        const filters: [string, unknown][] = [];
        async function run() {
          if (unavailable) return { data: null, error: { code: "08000" } };
          if (insert) {
            if (
              rows.some(
                (r) =>
                  r.connection_id === insert!.connection_id &&
                  r.tool_name === insert!.tool_name &&
                  r.operation_key === insert!.operation_key,
              )
            )
              return { data: null, error: { code: "23505" } };
            const row = { id: "receipt", status: "executing", ...insert };
            rows.push(row);
            return { data: row, error: null };
          }
          const row = rows.find((r) => filters.every(([key, value]) => r[key] === value));
          if (row && update) Object.assign(row, update);
          return { data: row ?? null, error: row ? null : { code: "missing" } };
        }
        const query = {
          insert(value: Record<string, unknown>) {
            insert = value;
            return query;
          },
          update(value: Record<string, unknown>) {
            update = value;
            return query;
          },
          select() {
            return query;
          },
          eq(key: string, value: unknown) {
            filters.push([key, value]);
            return query;
          },
          single: run,
          then(resolve: (value: unknown) => unknown) {
            return run().then(resolve);
          },
        };
        return query;
      },
    },
  } as unknown as McpContext;
  return {
    ctx,
    rows,
    fail: () => {
      unavailable = true;
    },
  };
}
describe("persistent MCP external-effect receipts", () => {
  it("claims before concurrent effects and returns the original result on replay", async () => {
    const { ctx } = fixture();
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const execute = async () => {
      calls++;
      await wait;
      return { message_id: "message", status: "sent" };
    };
    const first = withOperationReceipt(ctx, "send", "key", { body: "hello" }, execute);
    const second = await withOperationReceipt(ctx, "send", "key", { body: "hello" }, execute);
    expect(second).toMatchObject({ status: "executing" });
    expect(calls).toBe(1);
    release();
    const original = await first;
    expect(await withOperationReceipt(ctx, "send", "key", { body: "hello" }, execute)).toEqual(
      original,
    );
    expect(calls).toBe(1);
    await expect(
      withOperationReceipt(ctx, "send", "key", { body: "changed" }, execute),
    ).rejects.toThrow("parâmetros diferentes");
  });
  it("does not dispatch when reservation storage is unavailable", async () => {
    const f = fixture();
    f.fail();
    let calls = 0;
    await expect(
      withOperationReceipt(f.ctx, "send", "key", {}, async () => {
        calls++;
      }),
    ).rejects.toThrow("reservar");
    expect(calls).toBe(0);
  });
  it("never repeats a failed or unacknowledged effect", async () => {
    const { ctx } = fixture();
    let calls = 0;
    const execute = async () => {
      calls++;
      throw new Error("provider timeout");
    };
    await expect(withOperationReceipt(ctx, "send", "key", {}, execute)).rejects.toThrow("timeout");
    expect(await withOperationReceipt(ctx, "send", "key", {}, execute)).toMatchObject({
      status: "uncertain",
    });
    expect(calls).toBe(1);
  });
});
