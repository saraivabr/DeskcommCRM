import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { motivoDoErro, sql } from "./psql-transporte";
let sequence = 0;
function denied(query: string, reason: string) {
  let error: unknown;
  try {
    sql(query);
  } catch (value) {
    error = value;
  }
  expect(error).toBeDefined();
  expect(motivoDoErro(error)).toContain(reason);
}
function seed(external?: string) {
  sequence++;
  const org = randomUUID(),
    actor = randomUUID(),
    connection = randomUUID(),
    asset = randomUUID(),
    session = randomUUID(),
    remote = external ?? String(4118000 + sequence);
  sql(`insert into public.organizations(id,slug,legal_name,display_name) values('${org}','messaging-${sequence}','Synthetic','Synthetic');
    insert into auth.users(id,email) values('${actor}','messaging-${sequence}@invariant.test');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values('${actor}','${org}','admin',now());
    insert into public.meta_connections(id,organization_id,app_id,local_actor_id,remote_actor_id,status,scopes) values('${connection}','${org}','441800001','${actor}','${remote}1','healthy',array['pages_messaging','pages_manage_metadata']);
    insert into public.meta_assets(id,organization_id,kind,external_id,name) values('${asset}','${org}','page','${remote}','Page');
    insert into public.meta_asset_grants(organization_id,connection_id,asset_id,selected,tasks,permissions) values('${org}','${connection}','${asset}',true,array['MESSAGING'],array['pages_messaging','pages_manage_metadata']);`);
  return { org, actor, connection, asset, session, remote };
}
function connect(s: ReturnType<typeof seed>) {
  sql(
    `insert into public.channel_sessions(id,organization_id,provider,meta_social_asset_id,meta_social_connection_id,meta_social_external_id,status,webhook_secret_encrypted,metadata) values('${s.session}','${s.org}','meta_social','${s.asset}','${s.connection}','${s.remote}','WORKING',public.fn_encrypt_oauth('synthetic-unused-secret'),'{"social_platform":"facebook"}');`,
  );
}
function enqueue(s: ReturnType<typeof seed>, mid = "m_queue") {
  const envelope = { object: "page", entry: [{ id: s.remote, messaging: [{ sender: { id: "20" }, recipient: { id: s.remote }, timestamp: Date.now(), message: { mid, text: "Synthetic private inbox content" } }] }] };
  const payload = JSON.stringify(envelope).replaceAll("'", "''");
  sql(`select public.fn_meta_messaging_accept('${payload}'::jsonb);`);
  return sql(`select id from public.event_log where organization_id='${s.org}' and event_type='channel.messaging_received' order by created_at desc limit 1;`);
}
beforeAll(() => {
  sql(
    "insert into private.app_secrets(name,value) values('nuvemshop_oauth_key','messaging-invariant-key-at-least-thirty-two-characters') on conflict(name) do update set value=excluded.value;",
  );
  sql("insert into public.platform_meta_app(id,app_id,config_id,native_enabled,instagram_enabled,ads_enabled) values(1,'441800001','441800002',true,true,true) on conflict(id) do update set app_id=excluded.app_id,native_enabled=true,instagram_enabled=true;");
});
describe("native messaging provenance and isolation", () => {
  it("routes through a current selected tenant grant and disappears on revoke", () => {
    const s = seed();
    connect(s);
    const result = JSON.parse(
      sql(`select public.fn_meta_messaging_resolve_entry('${s.remote}','facebook');`),
    );
    expect(result).toHaveLength(1);
    expect(result[0].organization_id).toBe(s.org);
    expect(
      sql(
        `select jsonb_array_length(public.fn_meta_messaging_resolve_entry('${s.remote}','instagram'));`,
      ),
    ).toBe("0");
    sql(
      `update public.meta_asset_grants set selected=false where organization_id='${s.org}' and connection_id='${s.connection}';`,
    );
    expect(sql(`select status from public.channel_sessions where id='${s.session}';`)).toBe(
      "STOPPED",
    );
    expect(
      sql(
        `select jsonb_array_length(public.fn_meta_messaging_resolve_entry('${s.remote}','facebook'));`,
      ),
    ).toBe("0");
  });
  it("forbids browser administrators from changing native entry provenance", () => {
    const s = seed();
    connect(s);
    denied(
      `begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"${s.actor}","role":"authenticated"}',true); update public.channel_sessions set meta_social_external_id='9999' where id='${s.session}'; commit;`,
      "native_messaging_service_only",
    );
    denied(
      `begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"${s.actor}","role":"authenticated"}',true); select public.fn_meta_messaging_resolve_entry('${s.remote}','facebook'); commit;`,
      "permission denied",
    );
    expect(
      sql(`select meta_social_external_id from public.channel_sessions where id='${s.session}';`),
    ).toBe(s.remote);
  });
  it("rejects mismatched external/platform provenance even through trusted writes", () => {
    const s = seed();
    connect(s);
    denied(
      `update public.channel_sessions set meta_social_external_id='9999' where id='${s.session}';`,
      "native_messaging_provenance_invalid",
    );
    denied(
      `update public.channel_sessions set metadata='{"social_platform":"instagram"}' where id='${s.session}';`,
      "native_messaging_provenance_invalid",
    );
  });
  it("globally unique routing rejects the same provider entry in another tenant", () => {
    const s = seed();
    connect(s);
    const other = seed(s.remote);
    denied(
      `insert into public.channel_sessions(id,organization_id,provider,meta_social_asset_id,meta_social_connection_id,meta_social_external_id,status,webhook_secret_encrypted,metadata) values('${other.session}','${other.org}','meta_social','${other.asset}','${other.connection}','${other.remote}','WORKING',public.fn_encrypt_oauth('synthetic-unused-secret'),'{"social_platform":"facebook"}');`,
      "channel_sessions_meta_social_external_active_unique",
    );
  });
  it("durably accepts, consumes once, and keeps native Inbox manual", () => {
    const s = seed(); connect(s);
    const event = enqueue(s);
    expect(sql(`select public.fn_meta_messaging_ingest('${event}');`)).toBe("t");
    expect(sql(`select public.fn_meta_messaging_ingest('${event}');`)).toBe("t");
    expect(sql(`select count(*) from public.messages where organization_id='${s.org}';`)).toBe("1");
    expect(sql(`select unread_count_for_assignee from public.conversations where organization_id='${s.org}';`)).toBe("1");
    expect(sql(`select count(*) from public.event_log where organization_id='${s.org}' and event_type='message.received';`)).toBe("0");
  });
  it("keeps private ingress invisible and unforgable by authenticated organization members", () => {
    const s = seed(); connect(s); const event = enqueue(s);
    expect(sql(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"${s.actor}","role":"authenticated"}',true);
      select count(*) from public.event_log where id='${event}'; rollback;`).split("\n")).toContain("0");
    denied(`begin; set local role authenticated; select set_config('request.jwt.claims','{"sub":"${s.actor}","role":"authenticated"}',true);
      select public.emit_event('channel.messaging_received','channel_session','${s.session}','{}'::jsonb,'{}'::jsonb,'${s.org}'); rollback;`, "native_messaging_event_service_only");
  });
  it("holds parent and channel share locks until durable acceptance commits", () => {
    const s = seed(); connect(s);
    const envelope = JSON.stringify({object:"page",entry:[{id:s.remote,messaging:[]} ]});
    const result = sql(`begin; select public.fn_meta_messaging_accept('${envelope}'::jsonb);
      select count(distinct relation) from pg_locks where pid=pg_backend_pid() and mode='RowShareLock' and granted
        and relation in ('public.meta_connections'::regclass,'public.channel_sessions'::regclass); rollback;`);
    expect(result.split("\n")).toContain("2");
  });
  it("rechecks granular targets before consuming already accepted jobs", () => {
    const s = seed(); connect(s); const event = enqueue(s);
    sql(`update public.meta_connections set granular_scopes='[{"scope":"pages_messaging","target_ids":[]}]'::jsonb where id='${s.connection}';`);
    expect(sql(`select public.fn_meta_messaging_ingest('${event}');`)).toBe("f");
    expect(sql(`select count(*) from public.messages where organization_id='${s.org}';`)).toBe("0");
  });
  it("reuses the winning CRM contact through the existing provider thread", () => {
    const s = seed(); connect(s); const winner = randomUUID(), conversation = randomUUID();
    sql(`insert into public.contacts(id,organization_id,name,source) values('${winner}','${s.org}','Independent CRM','manual');
      insert into public.conversations(id,organization_id,contact_id,channel_session_id,channel,provider_conversation_id) values('${conversation}','${s.org}','${winner}','${s.session}','facebook','20');`);
    const event = enqueue(s);
    expect(sql(`select public.fn_meta_messaging_ingest('${event}');`)).toBe("t");
    expect(sql(`select count(*) from public.contacts where organization_id='${s.org}';`)).toBe("1");
    expect(sql(`select contact_id from public.messages where organization_id='${s.org}';`)).toBe(winner);
  });
  it("purges durable private payloads when deleting a connection before consumption", () => {
    const s = seed(); connect(s); const event = enqueue(s);
    sql(`delete from public.meta_connections where id='${s.connection}';`);
    expect(sql(`select count(*) from public.event_log where id='${event}';`)).toBe("0");
    expect(sql(`select public.fn_meta_messaging_ingest('${event}');`)).toBe("f");
  });
  it("deploy gate rejects partial installation and unsafe callable ACLs", () => {
    const contract = readFileSync("scripts/deploy-meta-messaging-contract.sql", "utf8");
    expect(sql(contract)).toBe("ready");
    expect(sql(`begin; drop policy event_log_native_messaging_private on public.event_log; ${contract} rollback;`)).toContain("incompatible");
    expect(sql(`begin; drop trigger channel_sessions_meta_messaging_guard on public.channel_sessions; ${contract} rollback;`)).toContain("partial");
    expect(sql(`begin; grant execute on function public.fn_meta_messaging_accept(jsonb) to authenticated; ${contract} rollback;`)).toContain("incompatible");
  });
  it("refuses unknown core emitters before installing or replacing functions", () => {
    const contract = readFileSync("scripts/deploy-meta-messaging-contract.sql", "utf8");
    const migration = readFileSync("supabase/migrations/20261006223000_0418_meta_social_messaging.sql", "utf8");
    const unknown = "create or replace function public.fn_emit_message_event() returns trigger language plpgsql as $$ begin return new;end;$$;";
    expect(sql(`begin; ${unknown} ${contract} rollback;`)).toContain("incompatible");
    denied(`begin; ${unknown} ${migration} rollback;`, "meta_messaging_core_unknown");
  });
  it("erases native/tombstone ids and preserves merged CRM without another conversation", () => {
    const s = seed();
    connect(s);
    const winner = randomUUID(),
      loser = randomUUID(),
      conversation = randomUUID(),
      message = randomUUID();
    sql(`insert into public.contacts(id,organization_id,name,phone_number,email,source) values('${winner}','${s.org}','Independent CRM name','+5511999998888','independent@example.test','manual');
      insert into public.contacts(id,organization_id,name,social_identity,is_merged_into,source) values('${loser}','${s.org}',null,'facebook:${s.remote}:20','${winner}','social');
      insert into public.conversations(id,organization_id,contact_id,channel_session_id,channel,provider_conversation_id,last_message_preview) values('${conversation}','${s.org}','${winner}','${s.session}','facebook','20','Meta-derived text');
      insert into public.messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,status,type,body,external_id) values('${message}','${s.org}','${winner}','${conversation}','${s.session}','inbound','delivered','text','Meta-derived text','meta:${s.remote}:m_1');
      insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload) values('${s.org}','message.received','message','${message}',jsonb_build_object('message_id','${message}','body_preview','Meta-derived text','external_id','meta:${s.remote}:m_1'));
      delete from public.meta_asset_grants where organization_id='${s.org}' and connection_id='${s.connection}'; delete from public.meta_connections where organization_id='${s.org}' and id='${s.connection}';`);
    expect(sql(`select count(*) from public.event_log where organization_id='${s.org}' and payload->>'message_id'='${message}';`)).toBe("0");
    expect(
      sql(`select name||'|'||phone_number||'|'||email from public.contacts where id='${winner}';`),
    ).toBe("Independent CRM name|+5511999998888|independent@example.test");
    expect(sql(`select social_identity is null from public.contacts where id='${loser}';`)).toBe(
      "t",
    );
    expect(
      sql(
        `select body||'|'||(external_id is null)::text from public.messages where id='${message}';`,
      ),
    ).toBe("[mensagem anonimizada]|true");
    expect(
      sql(
        `select (provider_conversation_id is null)::text||'|'||(last_message_preview is null)::text from public.conversations where id='${conversation}';`,
      ),
    ).toBe("true|true");
    expect(
      sql(
        `select (archived_at is not null)::text||'|'||(meta_social_external_id is null)::text from public.channel_sessions where id='${s.session}';`,
      ),
    ).toBe("true|true");
  });
});
