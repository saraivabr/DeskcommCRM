import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { VersionHistory } from "@/app/app/ai/agents/[id]/_components/VersionHistory";
import { AgentTabs } from "@/app/app/ai/agents/[id]/_components/AgentTabs";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";
import type { AgentRow } from "@/hooks/ai/useAgent";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const versions = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    agent_id: "agent-1",
    version_number: 1,
    status: "published",
    system_prompt: "Instrução publicada",
    provider: "openai",
    model: "gpt-4o",
    tool_ids: ["crm_read"],
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    agent_id: "agent-1",
    version_number: 2,
    status: "draft",
    system_prompt: "Instrução exata da aprovação",
    provider: "anthropic",
    model: "claude-sonnet",
    tool_ids: ["knowledge_search"],
    created_at: "2026-01-02T00:00:00Z",
  },
] as AgentVersionRow[];

afterEach(cleanup);

describe("revisão de versão antes da aprovação", () => {
  it("abre o histórico quando a URL solicita uma versão", () => {
    render(
      <AgentTabs
        agent={{ id: "agent-1" } as AgentRow}
        draft={versions[1]!}
        published={versions[0]!}
        base={versions[1]!}
        versions={versions}
        credentials={[]}
        channelSessions={[]}
        reviewVersionId={versions[1]!.id}
        readOnly
      />,
    );

    expect(screen.getByRole("tab", { name: "Histórico" }).getAttribute("data-state")).toBe("active");
    expect(screen.getByRole("region", { name: "Versão solicitada para publicação" }).textContent).toContain("Instrução exata da aprovação");
  });

  it("mostra a versão solicitada, mesmo quando a publicada é diferente", () => {
    render(
      <VersionHistory
        agentId="agent-1"
        versions={versions}
        reviewVersionId={versions[1]!.id}
        readOnly
      />,
    );

    const review = screen.getByRole("region", { name: "Versão solicitada para publicação" });
    expect(review.textContent).toContain("v2");
    expect(review.textContent).toContain("Instrução exata da aprovação");
    expect(review.textContent).not.toContain("Instrução publicada");
    expect(review.textContent).toContain("knowledge_search");
  });

  it("avisa quando a versão pedida não pertence às versões carregadas", () => {
    render(
      <VersionHistory
        agentId="agent-1"
        versions={versions}
        reviewVersionId="33333333-3333-4333-8333-333333333333"
        readOnly
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("não foi encontrada");
  });
});
