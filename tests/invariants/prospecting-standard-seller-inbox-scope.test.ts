import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: process.env.TEST_DB_CONN ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 1,
});
const org = randomUUID(), foreignOrg = randomUUID();
const admin = randomUUID(), foreignAdmin = randomUUID(), ownAgent = randomUUID();
const channel = randomUUID(), foreignChannel = randomUUID();
const conversation = randomUUID(), generalConversation = randomUUID(), foreignConversation = randomUUID();
const agent = randomUUID(), foreignSeller = randomUUID(), version = randomUUID(), foreignVersion = randomUUID();
const campaign = randomUUID(), foreignCampaign = randomUUID();
let client: pg.PoolClient;

async function claims(user: string, role = "authenticated") {
  await client.query("select set_config('request.jwt.claims',$1,true),set_config('request.jwt.claim.role',$2,true)", [
    JSON.stringify({ sub: user, role }), role,
  ]);
}
async function availability(id = conversation) {
  return (await client.query<{ available: boolean }>(
    "select public.automatico_da_prospeccao(c) as available from public.conversations c where c.id=$1", [id],
  )).rows[0]?.available;
}

beforeAll(async () => {
  await pool.query("insert into auth.users(id,email) values($1,$4),($2,$5),($3,$6)", [admin, foreignAdmin, ownAgent, `${admin}@invariant.test`, `${foreignAdmin}@invariant.test`, `${ownAgent}@invariant.test`]);
  await pool.query("insert into organizations(id,slug,legal_name,display_name,settings) values($1,$3,'Scope','Scope','{\"visibility_mode\":\"own\"}'),($2,$4,'Foreign','Foreign','{}')", [org, foreignOrg, `inbox-${org}`, `inbox-${foreignOrg}`]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$4,'admin',now()),($2,$5,'admin',now()),($3,$4,'agent',now())", [admin, foreignAdmin, ownAgent, org, foreignOrg]);
  for (const [o, s, a, v, camp, conv] of [[org, channel, agent, version, campaign, conversation], [foreignOrg, foreignChannel, foreignSeller, foreignVersion, foreignCampaign, foreignConversation]]) {
    const contact = randomUUID();
    await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,decode('00','hex'))", [s, o, `scope-${s}`]);
    await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Scope contact')", [contact, o]);
    await pool.query("insert into conversations(id,organization_id,channel_session_id,contact_id,status) values($1,$2,$3,$4,'open')", [conv, o, s, contact]);
    await pool.query("insert into ai_agents(id,organization_id,name,kind,system_prompt,operation_mode,config) values($1,$2,'Seller','mcp_agent','Test','automatic','{\"managed_by\":\"prospecting\",\"standard_seller\":true}')", [a, o]);
    await pool.query("insert into ai_agent_versions(id,organization_id,agent_id,version_number,status,system_prompt,provider,model,channel_session_id) values($1,$2,$3,1,'published','Test','openai','test',$4)", [v, o, a, s]);
    await pool.query("update ai_agents set published_version_id=$1 where id=$2", [v, a]);
    await pool.query("insert into prospecting_campaigns(id,organization_id,request_id,name,search,config) values($1,$2,$3,'Scope','{}',$4::jsonb)", [camp, o, randomUUID(), JSON.stringify({ agent_id: a, channel_session_id: s, pipeline_id: randomUUID() })]);
    await pool.query("insert into prospecting_candidates(organization_id,campaign_id,place_id,data,status,conversation_id) values($1,$2,$3,'{}','sent',$4)", [o, camp, `scope-${conv}`, conv]);
  }
  const contact = randomUUID();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'General contact')", [contact, org]);
  await pool.query("insert into conversations(id,organization_id,channel_session_id,contact_id,status) values($1,$2,$3,$4,'open')", [generalConversation, org, channel, contact]);
});
beforeEach(async () => { client = await pool.connect(); await client.query("begin"); await claims(admin, "service_role"); });
afterEach(async () => { await client.query("rollback"); client.release(); });
afterAll(() => pool.end());

describe("standard seller computed availability preserves exact Inbox scope", () => {
  it("published seller attends its sent prospect, never a general conversation on the same channel", async () => {
    expect(await availability()).toBe(true);
    expect(await availability(generalConversation)).toBe(false);
    expect(await availability(foreignConversation)).toBe(true);
  });
  it.each(["new", "queued", "skipped", "failed"])("candidate %s is not engine-owned", async (status) => {
    await client.query("update prospecting_candidates set status=$1 where conversation_id=$2", [status, conversation]);
    expect(await availability()).toBe(false);
  });
  it("sending already belongs to the campaign", async () => {
    await client.query("update prospecting_candidates set status='sending' where conversation_id=$1", [conversation]);
    expect(await availability()).toBe(true);
  });
  it.each([
    { channel_session_id: foreignChannel }, { agent_id: foreignSeller }, { pipeline_id: null },
  ])("campaign must match actual channel, same-tenant agent and runtime context: %j", async (config) => {
    await client.query("update prospecting_campaigns set config=config || $1::jsonb where id=$2", [JSON.stringify(config), campaign]);
    expect(await availability()).toBe(false);
  });
  it.each([
    "paused_at=now()", "archived_at=now()", "operation_mode='assisted'", "published_version_id=null",
    "config='{\"managed_by\":\"prospecting\",\"standard_seller\":false}'::jsonb",
  ])("agent state must remain eligible: %s", async (state) => {
    await client.query(`update ai_agents set ${state} where id=$1`, [agent]);
    expect(await availability()).toBe(false);
  });
  it("a non-published version does not qualify", async () => {
    await client.query("update ai_agent_versions set status='archived' where id=$1", [version]);
    expect(await availability()).toBe(false);
  });
  it("SQL queue predicate excludes served prospects but preserves human handoff and general waiting", async () => {
    const ids = async () => (await client.query<{ id: string }>(
      `select id from conversations c where organization_id=$1 and public.comando_da_conversa(c) in ('aguardando','automatico')
       and (public.comando_da_conversa(c)<>'automatico' or not public.automatico_da_prospeccao(c))`, [org],
    )).rows.map((r) => r.id);
    expect(await ids()).toEqual([generalConversation]);
    await client.query("update conversations set bot_silenced_until='infinity' where id=$1", [conversation]);
    expect(new Set(await ids())).toEqual(new Set([conversation, generalConversation]));
  });
  it("authenticated users see only availability for conversations they may view; spoofed composite fields cannot override it", async () => {
    await client.query("set local role authenticated");
    await claims(admin);
    expect(await availability()).toBe(true);
    expect(await availability(foreignConversation)).toBeUndefined();
    const spoof = async (id: string, organization: string, assigned: string) => (await client.query<{ available: boolean }>(
      "select public.automatico_da_prospeccao(jsonb_populate_record(null::public.conversations,$1::jsonb)) as available",
      [JSON.stringify({ id, organization_id: organization, assigned_to_user_id: assigned })],
    )).rows[0]?.available;
    expect(await spoof(foreignConversation, foreignOrg, admin)).toBe(false);
    await claims(ownAgent);
    expect(await spoof(conversation, org, ownAgent)).toBe(false);
  });
  it("has no anonymous/public execute and grants no browser access to prospecting tables", async () => {
    const { rows } = await client.query<{ anon: boolean; authenticated: boolean; direct: boolean }>(
      `select has_function_privilege('anon','public.automatico_da_prospeccao(public.conversations)','execute') as anon,
       has_function_privilege('authenticated','public.automatico_da_prospeccao(public.conversations)','execute') as authenticated,
       has_table_privilege('authenticated','public.prospecting_candidates','select') as direct`,
    );
    expect(rows[0]).toEqual({ anon: false, authenticated: true, direct: false });
  });
});
