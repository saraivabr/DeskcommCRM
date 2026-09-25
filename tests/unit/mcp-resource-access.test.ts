import { describe, expect, it } from "vitest";
import {
  canViewConversation,
  conversationAccess,
  requireConversationAccess,
} from "@/lib/mcp/resource-access";
import type { McpContext } from "@/lib/mcp/types";
const userId = "11111111-1111-4111-8111-111111111111";
function context(settings: object | null, assignedTo: string | null = null) {
  const filters: [string, unknown][] = [];
  const ctx = {
    connectionId: "connection",
    userId,
    role: "agent",
    organizationId: "org",
    supabase: {
      from(table: string) {
        const query = {
          select() {
            return query;
          },
          eq(key: string, value: unknown) {
            filters.push([key, value]);
            return query;
          },
          async maybeSingle() {
            return {
              data:
                table === "organizations"
                  ? settings === null
                    ? null
                    : { settings }
                  : { assigned_to_user_id: assignedTo },
              error: null,
            };
          },
        };
        return query;
      },
    },
  } as unknown as McpContext;
  return { ctx, filters };
}
describe("user-bound MCP resource access", () => {
  it("keeps unknown settings restrictive and fails closed on missing organization", async () => {
    expect((await conversationAccess(context({ visibility_mode: "unexpected" }).ctx))?.mode).toBe(
      "own",
    );
    expect((await conversationAccess(context({}).ctx))?.mode).toBe("own_and_unassigned");
    await expect(conversationAccess(context(null).ctx)).rejects.toThrow();
  });
  it("restricts agent ownership and preserves organization-wide modes", () => {
    expect(canViewConversation({ userId, mode: "own" }, userId)).toBe(true);
    expect(canViewConversation({ userId, mode: "own" }, null)).toBe(false);
    expect(canViewConversation({ userId, mode: "own_and_unassigned" }, null)).toBe(true);
    expect(canViewConversation({ userId, mode: "own_and_unassigned" }, "other")).toBe(false);
    expect(canViewConversation({ userId, mode: "all" }, "other")).toBe(true);
  });
  it("denies hidden conversations and binds lookups to the trusted organization", async () => {
    const { ctx, filters } = context({ visibility_mode: "own" }, "other");
    await expect(requireConversationAccess(ctx, "conversation")).rejects.toThrow("sem acesso");
    expect(filters).toContainEqual(["organization_id", "org"]);
    expect(filters).toContainEqual(["id", "conversation"]);
  });
  it("does not change legacy service tokens", async () => {
    const { ctx } = context(null);
    delete ctx.connectionId;
    expect(await conversationAccess(ctx)).toBeUndefined();
  });
});
