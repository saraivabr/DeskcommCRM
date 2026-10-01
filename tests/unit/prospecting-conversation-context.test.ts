import { describe, expect, it, vi } from "vitest";
import { prospectingConversationContext } from "@/lib/prospecting/context";
import { PROSPECTING_REPLY_GUIDANCE } from "@/lib/prospecting/conversation-guidance";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { campaignConfigSchema } from "@/lib/prospecting/schema";

const org = "10000000-0000-4000-8000-000000000001";
const conversation = "10000000-0000-4000-8000-000000000002";
const config = campaignConfigSchema.parse({
  agent_id: org,
  channel_session_id: org,
  pipeline_id: org,
  stage_id: org,
  qualified_stage_id: conversation,
  instruction: "Apresentar uma solução de acompanhamento comercial",
  qualification: "Interesse confirmado pela pessoa responsável",
  legal_basis_ref: "LIA-example",
});

function database(configs: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows: configs.map((config) => ({ config })) });
  return { query };
}

describe("prospecting reply context for existing campaigns", () => {
  it("injects the current guidance without rewriting the published agent or campaign", async () => {
    const db = database([config]);
    const context = await prospectingConversationContext(db as Queryable, org, conversation);
    expect(context).toContain(config.instruction);
    expect(context).toContain(config.qualification);
    expect(context).toContain(PROSPECTING_REPLY_GUIDANCE);
    expect(context).toContain(`funil ${config.pipeline_id}`);
    expect(context).toContain(`etapa ${config.qualified_stage_id}`);
    expect(context).toContain("mantenha a etapa atual; não pressione");
    expect(context).not.toContain("Se faltar informação, continue qualificando");
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = db.query.mock.calls[0]!;
    expect(sql).toContain("p.organization_id=$1 and p.conversation_id=$2");
    expect(sql).toContain("c.organization_id=p.organization_id");
    expect(sql).toContain("p.status in ('sending','sent')");
    expect(parameters).toEqual([org, conversation]);
  });

  it("answers questions and separates automated reception from real interest", async () => {
    const context = await prospectingConversationContext(
      database([config]) as Queryable,
      org,
      conversation,
    );
    expect(context).toContain("Responda primeiro ao que a pessoa perguntou");
    expect(context).toContain("sem inventar preço nem desviar para perguntas de qualificação");
    expect(context).toContain(
      "Saudação automática, menu de atendimento ou aviso de ausência NÃO comprovam interesse",
    );
    expect(context).toContain("aguarde uma resposta humana");
    expect(context).toContain("Não trate a recepção como comprador");
    expect(context).toContain("Convide para reunião somente após interesse real");
  });

  it.each([{ configs: [] }, { configs: [{ instruction: "invalid config" }] }])(
    "does not apply prospecting rules without valid campaign context: %j",
    async ({ configs }) => {
      expect(
        await prospectingConversationContext(database(configs) as Queryable, org, conversation),
      ).toBe("");
    },
  );
});
