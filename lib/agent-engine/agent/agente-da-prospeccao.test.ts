import { describe, expect, it, vi } from "vitest";
import { agenteDaProspeccaoDaConversa } from "./agente-da-prospeccao";

describe("seller of the exact prospecting conversation", () => {
  it("resolves agent and CRM scope using organization, conversation and incoming channel", async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ agent_id: "seller", pipeline_id: "pipeline" }] });
    expect(
      await agenteDaProspeccaoDaConversa({ query } as never, "org", "conversation", "channel"),
    ).toEqual({ agentId: "seller", pipelineId: "pipeline" });
    const [sql, parameters] = query.mock.calls[0]!;
    expect(parameters).toEqual(["org", "conversation", "channel"]);
    expect(sql).toContain("c.organization_id=p.organization_id");
    expect(sql).toContain("p.organization_id=$1 and p.conversation_id=$2");
    expect(sql).toContain("c.config->>'channel_session_id'=$3");
    expect(sql).toContain("p.status in ('sending','sent')");
  });
  it.each([{ rows: [] }, { rows: [{ agent_id: "seller", pipeline_id: null }] }])(
    "does not assign a seller without campaign scope",
    async ({ rows }) => {
      const query = vi.fn().mockResolvedValue({ rows });
      expect(
        await agenteDaProspeccaoDaConversa({ query } as never, "org", "other", "channel"),
      ).toBeNull();
    },
  );
  it("returns to regular channel routing when lookup is unavailable", async () => {
    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
    expect(
      await agenteDaProspeccaoDaConversa({ query } as never, "org", "conversation", "channel"),
    ).toBeNull();
  });
});
