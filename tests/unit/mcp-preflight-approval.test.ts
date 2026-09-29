import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const spies = vi.hoisted(() => ({
  validate: vi.fn(),
  approval: vi.fn(),
  handler: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: spies.audit }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: vi.fn() }));
vi.mock("@/lib/mcp/connections", () => ({
  resolveConnection: async () => ({ role: "agent", connectionId: "personal", userId: "user" }),
}));
vi.mock("@/lib/mcp/approvals", () => ({ withActionApproval: spies.approval }));
vi.mock("@/lib/mcp/tools", () => ({
  allTools: [
    {
      name: "crm_generate_reply_draft",
      description: "Prepare a reply for review",
      inputSchema: { conversation_id: z.string().uuid() },
      category: "write",
      requiresRole: "agent",
      requiresScope: "mcp:write",
      validateBeforeApproval: spies.validate,
      handler: spies.handler,
    },
  ],
}));
const { createMcpServer } = await import("@/lib/mcp/server");

async function call() {
  const server = createMcpServer(
    {
      connectionId: "personal",
      userId: "user",
      organizationId: "org",
      role: "agent",
      actor: { type: "user", id: "user" },
      apiTokenId: "personal",
      scopes: ["whatsapp:execute"],
    },
    "req",
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  try {
    return await client.callTool({
      name: "crm_generate_reply_draft",
      arguments: {
        conversation_id: "00000000-0000-4000-8000-000000000001",
      },
    });
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  spies.validate.mockResolvedValue(undefined);
  spies.approval.mockResolvedValue({ status: "confirmation_required" });
});
describe("MCP resource validation precedes personal approval", () => {
  it("denied resources cannot create approval requests or run the provider", async () => {
    spies.validate.mockRejectedValue(new Error("Conversa não encontrada ou sem acesso."));
    expect((await call()).isError).toBe(true);
    expect(spies.approval).not.toHaveBeenCalled();
    expect(spies.handler).not.toHaveBeenCalled();
    expect(spies.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
  it("accessible resources request approval only after validation", async () => {
    const result = await call();
    expect(result.isError).not.toBe(true);
    expect(spies.validate).toHaveBeenCalledOnce();
    expect(spies.approval).toHaveBeenCalledOnce();
    expect(spies.validate.mock.invocationCallOrder[0]).toBeLessThan(
      spies.approval.mock.invocationCallOrder[0]!,
    );
    expect(spies.handler).not.toHaveBeenCalled();
  });
});
