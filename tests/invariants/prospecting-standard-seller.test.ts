import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ai/runtime/agent", () => ({
  chaveDePlataforma: (provider: string) =>
    platform.enabled && provider === "openai" ? "synthetic-key-never-sent" : null,
}));

import { createMcpAgentDraft } from "@/lib/ai/agents/create-draft";
import { publishAgentVersionWithClient } from "@/lib/ai/agents/publish";
import { agenteDaProspeccaoDaConversa } from "@/lib/agent-engine/agent/agente-da-prospeccao";
import { prospectingConversationContext } from "@/lib/prospecting/context";
import {
  ensureStandardProspectingSeller,
  loadStandardSellerProfile,
  saveStandardSellerProfile,
} from "@/lib/prospecting/default-seller";
import type { CampaignConfig } from "@/lib/prospecting/schema";

// Only synthetic rows on the canonical baseline from scripts/test-db.sh.
// No provider, HTTP API, or production database is involved.
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DB_CONN ??
    `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
beforeEach(() => {
  platform.enabled = true;
});
afterAll(() => pool.end());

const profile = {
  seller_name: "Sara",
  company_name: "Empresa sintética",
  offer: "Organizar o atendimento comercial e o retorno aos interessados.",
};

async function fixture() {
  const org = randomUUID(),
    user = randomUUID(),
    channel = randomUUID();
  await pool.query("insert into auth.users(id,email) values($1,$2)", [
    user,
    `${user}@invariant.test`,
  ]);
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,created_by,settings) values($1,$2,'Synthetic seller','Synthetic seller',$3,$4::jsonb)",
    [
      org,
      `seller-${org}`,
      user,
      JSON.stringify({
        llm: { provider: "openai" },
        untouched: { keep: 42 },
        prospecting: { existing: "preserve" },
      }),
    ],
  );
  const pipeline = (
    await pool.query(
      "select id from crm_pipelines where organization_id=$1 and not is_archived order by created_at,id limit 1",
      [org],
    )
  ).rows[0].id as string;
  const stages = (
    await pool.query(
      "select id from crm_stages where organization_id=$1 and pipeline_id=$2 and not is_won and not is_lost order by position limit 2",
      [org, pipeline],
    )
  ).rows;
  await pool.query(
    "insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted) values($1,$2,'waha',$3,'WORKING',decode('00','hex'))",
    [channel, org, `seller-${channel}`],
  );
  await saveStandardSellerProfile(pool, org, profile);
  return { org, user, channel, pipeline, stages };
}

async function ensure(f: Awaited<ReturnType<typeof fixture>>, pipelineId = f.pipeline) {
  const db = await pool.connect();
  try {
    return await ensureStandardProspectingSeller(db, {} as SupabaseClient, f.org, {
      channel_session_id: f.channel,
      pipeline_id: pipelineId,
    });
  } finally {
    db.release();
  }
}

async function conversation(f: Awaited<ReturnType<typeof fixture>>) {
  const contact = randomUUID(),
    id = randomUUID();
  await pool.query(
    "insert into contacts(id,organization_id,name) values($1,$2,'Synthetic contact')",
    [contact, f.org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
    [id, f.org, contact, f.channel],
  );
  return id;
}

async function campaign(f: Awaited<ReturnType<typeof fixture>>, agentId: string, niche: string) {
  const id = randomUUID(),
    conversationId = await conversation(f);
  const config: CampaignConfig = {
    agent_id: agentId,
    channel_session_id: f.channel,
    pipeline_id: f.pipeline,
    stage_id: f.stages[0].id,
    qualified_stage_id: f.stages[1].id,
    instruction: profile.offer,
    qualification: "Interesse confirmado e desejo de avançar na conversa.",
    daily_limit: 10,
    interval_minutes: 15,
    legal_basis_ref: "Synthetic interest assessment",
    standard_seller: profile,
  };
  const search = {
    name: `${niche} · SP`,
    source: "google_maps",
    niche,
    location: "São Paulo",
    limit: 20,
    budget_usd: 1,
    enrich: true,
  };
  await pool.query(
    "insert into prospecting_campaigns(id,organization_id,request_id,name,search,config) values($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
    [id, f.org, randomUUID(), search.name, JSON.stringify(search), JSON.stringify(config)],
  );
  await pool.query(
    "insert into prospecting_candidates(organization_id,campaign_id,place_id,data,status,conversation_id) values($1,$2,$3,'{}','sent',$4)",
    [f.org, id, randomUUID(), conversationId],
  );
  return { id, conversationId, config };
}

it("atomically saves the seller profile without replacing unrelated settings or another tenant", async () => {
  const a = await fixture(),
    b = await fixture();
  const before = (await pool.query("select settings from organizations where id=$1", [a.org]))
    .rows[0].settings;
  await saveStandardSellerProfile(pool, a.org, {
    ...profile,
    seller_name: "Clara",
    offer: "Outra oferta real para o próximo lote de empresas.",
  });
  const settings = (await pool.query("select settings from organizations where id=$1", [a.org]))
    .rows[0].settings;
  expect(settings).toMatchObject({
    untouched: { keep: 42 },
    prospecting: { existing: "preserve", seller_name: "Clara" },
  });
  expect(settings.llm).toEqual(before.llm);
  expect(await loadStandardSellerProfile(pool, b.org)).toEqual(profile);
  await expect(saveStandardSellerProfile(pool, randomUUID(), profile)).rejects.toMatchObject({
    status: 404,
  });
});

it("reuses one canonically published seller across niches and pipelines while separating organizations", async () => {
  const a = await fixture(),
    b = await fixture();
  const first = await ensure(a);
  const clinics = await campaign(a, first.agent_id, "Clínicas"),
    restaurants = await campaign(a, first.agent_id, "Restaurantes");
  expect(await ensure(a)).toEqual(first);
  const secondPipeline = randomUUID();
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Second synthetic funnel','second-synthetic')",
    [secondPipeline, a.org],
  );
  expect(await ensure(a, secondPipeline)).toEqual(first);
  const other = await ensure(b);
  expect(other.agent_id).not.toBe(first.agent_id);
  const row = (
    await pool.query(
      "select a.paused_at,a.published_version_id,v.status,v.pipeline_ids from ai_agents a join ai_agent_versions v on v.organization_id=a.organization_id and v.id=a.published_version_id where a.organization_id=$1 and a.id=$2",
      [a.org, first.agent_id],
    )
  ).rows[0];
  expect(row.paused_at).toBeNull();
  expect(row.status).toBe("published");
  expect(row.pipeline_ids).toEqual(expect.arrayContaining([a.pipeline, secondPipeline]));
  expect(
    (await pool.query("select count(*)::int as n from ai_agents where organization_id=$1", [a.org]))
      .rows[0].n,
  ).toBe(1);
  expect(
    (
      await pool.query(
        "select count(*)::int as n from ai_agent_versions where organization_id=$1 and agent_id=$2 and status in ('published','superseded') and published_at is not null",
        [a.org, first.agent_id],
      )
    ).rows[0].n,
  ).toBe(2);
  expect(await prospectingConversationContext(pool, a.org, clinics.conversationId)).toContain(
    '"Clínicas"',
  );
  expect(await prospectingConversationContext(pool, a.org, restaurants.conversationId)).toContain(
    '"Restaurantes"',
  );
  for (const target of [clinics, restaurants]) {
    const context = await prospectingConversationContext(pool, a.org, target.conversationId);
    expect(context).toContain(profile.seller_name);
    expect(context).toContain(profile.company_name);
    expect(context).toContain(profile.offer);
  }
});

it("routes only the exact prospect conversation and rejects foreign organizations, channels and pending candidates", async () => {
  const a = await fixture(),
    b = await fixture();
  const first = await ensure(a),
    target = await campaign(a, first.agent_id, "Restaurantes");
  expect(await agenteDaProspeccaoDaConversa(pool, a.org, target.conversationId, a.channel)).toEqual(
    { agentId: first.agent_id, pipelineId: a.pipeline },
  );
  expect(
    await agenteDaProspeccaoDaConversa(pool, b.org, target.conversationId, a.channel),
  ).toBeNull();
  expect(
    await agenteDaProspeccaoDaConversa(pool, a.org, target.conversationId, b.channel),
  ).toBeNull();
  expect(
    await agenteDaProspeccaoDaConversa(pool, a.org, await conversation(a), a.channel),
  ).toBeNull();
  await pool.query(
    "update prospecting_candidates set status='queued' where organization_id=$1 and campaign_id=$2",
    [a.org, target.id],
  );
  expect(
    await agenteDaProspeccaoDaConversa(pool, a.org, target.conversationId, a.channel),
  ).toBeNull();
  expect(await prospectingConversationContext(pool, b.org, target.conversationId)).toBe("");
});

it("the canonical publish guard leaves a paused draft unpublished when its platform key is absent", async () => {
  const f = await fixture(),
    db = await pool.connect();
  try {
    const model = (
      await db.query(
        "select model_id from ai_models where provider='openai' and supports_tools and deprecated_at is null order by is_default_for_provider desc,model_id limit 1",
      )
    ).rows[0].model_id;
    await db.query("begin");
    const created = await createMcpAgentDraft(
      db,
      { orgId: f.org, userId: f.user },
      {
        name: "Synthetic paused seller",
        version: {
          provider: "openai",
          credential_id: null,
          model,
          system_prompt: "Synthetic commercial seller, never called externally.",
          pipeline_ids: [f.pipeline],
          channel_session_id: f.channel,
        },
      },
      { pausedAt: new Date() },
    );
    await db.query("commit");
    platform.enabled = false;
    await db.query("begin");
    expect(
      await publishAgentVersionWithClient(db, {
        orgId: f.org,
        agentId: created.agent.id,
        versionId: created.version.id,
      }),
    ).toMatchObject({ ok: false, code: "credential_missing" });
    await db.query("rollback");
    await db.query("begin");
    await expect(
      db.query(
        "select * from public.fn_publish_ai_agent_version($1::uuid,$2::uuid,$3::uuid,false,null)",
        [f.org, created.agent.id, created.version.id],
      ),
    ).rejects.toMatchObject({ code: "P0001", message: "credential_missing" });
    await db.query("rollback");
    const row = (
      await db.query(
        "select published_version_id,paused_at from ai_agents where organization_id=$1 and id=$2",
        [f.org, created.agent.id],
      )
    ).rows[0];
    expect(row.published_version_id).toBeNull();
    expect(row.paused_at).not.toBeNull();
    expect(
      (
        await db.query(
          "select count(*)::int as n from event_log where organization_id=$1 and event_type='ai_agent.published'",
          [f.org],
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await db.query("rollback");
    db.release();
  }
});
