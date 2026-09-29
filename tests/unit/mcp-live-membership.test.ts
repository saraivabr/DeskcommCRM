import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConnection } from "@/lib/mcp/connections";

const state = vi.hoisted(() => ({
  member: { role: "manager", revoked_at: null as string | null },
  queried: [] as string[],
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(table: string) {
      state.queried.push(table);
      const row: Record<string, unknown> =
        table === "mcp_connections"
          ? { id: "token", organization_id: "org", user_id: "user", revoked_at: null }
          : table === "user_organizations"
            ? { organization_id: "org", user_id: "user", ...state.member }
            : { id: "org", status: "active" };
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const query = {
        select: () => query,
        eq(key: string, value: unknown) {
          filters.push((r) => r[key] === value);
          return query;
        },
        is(key: string, value: unknown) {
          filters.push((r) => r[key] === value);
          return query;
        },
        async maybeSingle() {
          return { data: filters.every((f) => f(row)) ? row : null, error: null };
        },
      };
      return query;
    },
  }),
}));

beforeEach(() => {
  state.member = { role: "manager", revoked_at: null };
  state.queried = [];
});
describe("personal MCP live team membership", () => {
  it("an active member retains only the lower of live and originally granted roles", async () => {
    expect(await resolveConnection("token", "org", "admin")).toMatchObject({
      role: "manager",
      userId: "user",
    });
    expect(await resolveConnection("token", "org", "agent")).toMatchObject({ role: "agent" });
  });
  it("revoked membership denies the token even while the row and connection still exist", async () => {
    state.member.revoked_at = new Date().toISOString();
    await expect(resolveConnection("token", "org", "admin")).rejects.toThrow("não tem mais acesso");
    expect(state.queried).not.toContain("organizations");
  });
  it("membership is looked up in the authenticated tenant", async () => {
    await expect(resolveConnection("token", "another-org", "admin")).rejects.toThrow(
      "Conexão revogada",
    );
    expect(state.queried).not.toContain("user_organizations");
  });
});
