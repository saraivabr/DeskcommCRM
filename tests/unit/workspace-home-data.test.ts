import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { homeInputSchema, loadHomeOverview } from "@/lib/workspace/home";
function database(failure?: string) {
  const queries: { table: string; calls: unknown[][] }[] = [];
  const db = {
    from(table: string) {
      const record = { table, calls: [] as unknown[][] };
      queries.push(record);
      const q: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) =>
          resolve({ count: 4, data: [], error: table === failure ? { message: "failed" } : null }),
      };
      for (const method of [
        "select",
        "eq",
        "in",
        "not",
        "lt",
        "gte",
        "lte",
        "neq",
        "order",
        "limit",
      ])
        q[method] = (...args: unknown[]) => {
          record.calls.push([method, ...args]);
          return q;
        };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}
const now = new Date("2026-09-25T12:00:00Z");
describe("Home real", () => {
  it("nega escopo equipe para atendente antes de qualquer query", async () => {
    const { db, queries } = database();
    await expect(
      loadHomeOverview(db, "org", "user", "agent", { scope: "team", days: 7 }, now),
    ).rejects.toThrow("permissão");
    expect(queries).toEqual([]);
  });
  it("minhas filtra todas consultas pelo tenant e responsável, incluindo atividade", async () => {
    const { db, queries } = database();
    const result = await loadHomeOverview(
      db,
      "org-session",
      "user-session",
      "agent",
      { scope: "mine", days: 7 },
      now,
    );
    const owners: Record<string, string> = {
      conversations: "assigned_to_user_id",
      crm_leads: "owner_user_id",
      crm_tasks: "assigned_to",
      calendar_appointments: "owner_user_id",
    };
    for (const q of queries) {
      expect(q.calls).toContainEqual(["eq", "organization_id", "org-session"]);
      expect(q.calls).toContainEqual(["eq", owners[q.table], "user-session"]);
    }
    expect(result.canSeeTeam).toBe(false);
    expect(result.attention[0]?.href).toBe("/app/inbox?filter=mine");
    expect(queries[1]?.calls).toContainEqual(["lt", "expected_close_date", "2026-09-25"]);
    expect(queries[2]?.calls).toContainEqual(["in", "status", ["pending", "in_progress"]]);
    expect(queries[3]?.calls).toContainEqual(["gte", "created_at", "2026-09-18T12:00:00.000Z"]);
    expect(queries[6]?.calls).toContainEqual(["eq", "status", "won"]);
    expect(queries[7]?.calls).toContainEqual(["eq", "contacts.is_anonymized", false]);
  });
  it("equipe autorizada remove apenas filtro pessoal, nunca o tenant", async () => {
    const { db, queries } = database();
    const result = await loadHomeOverview(
      db,
      "org",
      "user",
      "manager",
      { scope: "team", days: 30 },
      now,
    );
    expect(result.canSeeTeam).toBe(true);
    for (const q of queries) {
      expect(q.calls).toContainEqual(["eq", "organization_id", "org"]);
      expect(q.calls.some((c) => c[0] === "eq" && c[2] === "user")).toBe(false);
    }
  });
  it("erro parcial vira indisponível e não zero nem apaga indicadores sadios", async () => {
    const { db } = database("crm_leads");
    const result = await loadHomeOverview(
      db,
      "org",
      "user",
      "agent",
      { scope: "mine", days: 7 },
      now,
    );
    expect(result.attention[1]?.count).toBeNull();
    expect(result.attention[0]?.count).toBe(4);
    expect(result.movement[3]?.count).toBeNull();
  });
  it("schema não aceita tenant ou responsável do cliente nem período ilimitado", () => {
    expect(homeInputSchema.safeParse({ scope: "mine", days: 7, orgId: "other" }).success).toBe(
      false,
    );
    expect(homeInputSchema.safeParse({ scope: "team", days: 365 }).success).toBe(false);
    expect(homeInputSchema.parse({})).toEqual({ scope: "mine", days: 7 });
  });
});
