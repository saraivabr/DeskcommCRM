import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { motivoDoErro, sql } from "./psql-transporte";

const APP = "441700001";
const worker = "privacy-invariant-worker";
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const json = (input: unknown) => `'${JSON.stringify(input).replaceAll("'", "''")}'::jsonb`;
const result = <T>(query: string): T => JSON.parse(sql(query).split("\n").at(-1) ?? "null") as T;
const contract = readFileSync("scripts/deploy-meta-privacy-contract.sql", "utf8");
const nativeContract = readFileSync("scripts/deploy-meta-native-contract.sql", "utf8");
const migration = readFileSync(
  "supabase/migrations/20261006193000_0417_meta_privacy_lifecycle.sql",
  "utf8",
);
const state = (mutation = "") =>
  sql(`begin;${mutation}\n${contract}\nrollback;`)
    .split("\n")
    .find((value) =>
      ["ready", "missing", "partial", "incompatible", "dependencies_missing"].includes(value),
    );
function denied(query: string, reason: string) {
  let failure: unknown;
  try {
    sql(query);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(motivoDoErro(failure)).toContain(reason);
}

interface Seed {
  org: string;
  actor: string;
  connection: string;
  page: string;
  asset: string;
  grant: string;
  remote: string;
  publication: string;
  original: string;
  neighbor?: string;
}
interface Receipt {
  request_id: string;
  confirmation_code_encrypted: string;
  status: string;
}
interface Claim {
  id: string;
  fence: number;
  lease_until: string;
}
interface Step {
  status: string;
  more: boolean;
  storage_objects: {
    id: string;
    organization_id: string;
    publication_id: string;
    index: number;
    path: string;
  }[];
}
let sequence = 0;
function seed(shared = false, publication = true): Seed {
  sequence++;
  const value: Seed = {
    org: randomUUID(),
    actor: randomUUID(),
    connection: randomUUID(),
    page: randomUUID(),
    asset: randomUUID(),
    grant: randomUUID(),
    remote: String(900000 + sequence),
    publication: randomUUID(),
    original: randomUUID(),
    ...(shared ? { neighbor: randomUUID() } : {}),
  };
  sql(`insert into public.organizations(id,slug,legal_name,display_name) values('${value.org}','privacy-${sequence}','Synthetic','Synthetic');
    insert into auth.users(id,email) values('${value.actor}','privacy-${sequence}@invariant.test');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at) values('${value.actor}','${value.org}','admin',now());
    insert into public.meta_connections(id,organization_id,app_id,local_actor_id,remote_actor_id,actor_name,oauth_access_token_encrypted,scopes,status)
      values('${value.connection}','${value.org}','${APP}','${value.actor}','${value.remote}','Personal Meta name',public.fn_encrypt_oauth('synthetic-token'),array['instagram_basic','instagram_content_publish','pages_read_engagement'],'healthy');
    insert into public.meta_assets(id,organization_id,kind,external_id,name) values('${value.page}','${value.org}','page','${value.remote}1','Page'),('${value.asset}','${value.org}','instagram','${value.remote}2','Instagram');
    update public.meta_assets set parent_page_id='${value.page}' where id='${value.asset}';
    insert into public.meta_asset_grants(id,organization_id,connection_id,asset_id,selected,tasks,permissions,page_access_token_encrypted)
      values('${value.grant}','${value.org}','${value.connection}','${value.asset}',true,array['CREATE_CONTENT'],array['instagram_basic','instagram_content_publish','pages_read_engagement'],public.fn_encrypt_oauth('synthetic-page-token'));
    insert into public.meta_asset_grants(organization_id,connection_id,asset_id,selected,tasks,permissions)
      values('${value.org}','${value.connection}','${value.page}',true,array['CREATE_CONTENT'],array['pages_read_engagement']);
    insert into public.instagram_studio_items(id,organization_id,kind,status,input,asset_path,caption)
      values('${value.original}','${value.org}','post','ready','{"format":"square"}','${value.org}/instagram/original.jpg','Original Studio copy');
    insert into public.instagram_publications(id,organization_id,account_id,item_ids,format,caption)
      values('${randomUUID()}','${value.org}','legacy-zernio',array['${value.original}'::uuid],'feed','Legacy retained');`);
  if (value.neighbor)
    sql(`insert into public.meta_connections(id,organization_id,app_id,local_actor_id,remote_actor_id,oauth_access_token_encrypted,status)
    values('${value.neighbor}','${value.org}','${APP}','${value.actor}','${value.remote}9',public.fn_encrypt_oauth('independent-token'),'healthy');
    insert into public.meta_asset_grants(organization_id,connection_id,asset_id,selected,tasks,permissions)
      select '${value.org}','${value.neighbor}',id,true,array['CREATE_CONTENT'],array['instagram_basic','instagram_content_publish','pages_read_engagement']
      from public.meta_assets where organization_id='${value.org}';`);
  if (publication)
    sql(`insert into public.instagram_publications(id,organization_id,account_id,item_ids,format,caption,provider,meta_asset_id,requested_by,meta_connection_id)
    values('${value.publication}','${value.org}','${value.remote}2',array['${value.original}'::uuid],'feed','Meta-derived caption','meta','${value.asset}','${value.actor}','${value.connection}');`);
  return value;
}
function request(
  value: Seed,
  kind = "data_deletion",
  digest = hash(value.remote + kind),
  code = hash("opaque:" + digest),
): Receipt {
  return result(
    `select public.fn_meta_privacy_request('${APP}','${value.remote}','${kind}','${digest}','${code}',now());`,
  );
}
function claim(): Claim {
  return result(`select public.fn_meta_privacy_claim('${worker}',90);`);
}
function step(lease: Claim, ids: string[] = []): Step {
  return result(
    `select public.fn_meta_privacy_step('${lease.id}','${worker}',${lease.fence},array[${ids.map((id) => `'${id}'::uuid`).join(",")} ]::uuid[],100);`,
  );
}
function finish(lease: Claim, initial?: Step) {
  let current = initial ?? step(lease);
  for (let tries = 0; current.more && tries < 40; tries++)
    current = step(
      lease,
      current.storage_objects.map((object) => object.id),
    );
  expect(current.status).toBe("completed");
  expect(current.more).toBe(false);
  expect(current.storage_objects).toEqual([]);
}
function reserve(value: Seed) {
  return result<{ operation: { id: string } }>(
    `select public.fn_meta_operation_reserve('${value.org}','${value.actor}','${value.connection}','${value.asset}','${value.grant}',1,'instagram_publish','${value.publication}','${hash(value.publication)}',${json({ publication_id: value.publication, caption: "Meta-derived caption" })});`,
  ).operation.id;
}
function attempt(value: Seed, remote: string, old = false) {
  const id = randomUUID();
  const ticket = hash(id + "ticket");
  sql(`insert into public.meta_oauth_attempts(id,organization_id,actor_id,auth_session_id,app_id,config_id,config_revision,state_hash,cookie_hash,ticket_hash,status,pending_result_encrypted,expires_at,created_at)
    select '${id}','${value.org}','${value.actor}','privacy-session',app_id,config_id,config_revision,'${hash(id + "state")}','${hash(id + "cookie")}','${ticket}','ready',
    public.fn_encrypt_oauth(${json({ access_token: "pending-token", remote_actor_id: remote, remote_actor_name: "Pending name", assets: [], scopes: [], granular_scopes: [] })}::text),now()+interval '10 minutes',now()${old ? "-interval '1 minute'" : ""}
    from public.platform_meta_app where id=1;`);
  return { id, ticket };
}
beforeAll(() => {
  sql(`insert into private.app_secrets(name,value) values('nuvemshop_oauth_key','meta-privacy-test-key-at-least-thirty-two-characters') on conflict(name) do update set value=excluded.value;
    insert into public.platform_meta_app(id,app_id,config_id,native_enabled,instagram_enabled,ads_enabled,app_secret_encrypted)
    values(1,'${APP}','441700002',true,true,true,public.fn_encrypt_oauth('synthetic-app-secret'))
    on conflict(id) do update set app_id=excluded.app_id,config_id=excluded.config_id,native_enabled=true,instagram_enabled=true,ads_enabled=true,app_secret_encrypted=excluded.app_secret_encrypted;`);
});

describe("Meta privacy provider lifecycle", () => {
  it("denies browser access to identities, receipts, targets, media queues and service RPCs", () => {
    for (const table of [
      "meta_privacy_subjects",
      "meta_privacy_requests",
      "meta_privacy_targets",
      "meta_privacy_storage_objects",
      "meta_privacy_media_tombstones",
    ]) {
      expect(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).toBe(
        "t",
      );
      for (const role of ["anon", "authenticated"])
        denied(`set role ${role};select * from public.${table};`, "permission denied");
    }
    expect(
      sql(
        "select bool_and(not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute')) from pg_proc where proname like 'fn_meta_privacy_%'",
      ),
    ).toBe("t");
  });

  it("denies owner and cross-org browser access to seeded cleanup records while allowing service access", () => {
    const own = seed(false, false);
    const neighbor = seed(false, false);
    for (const value of [own, neighbor]) {
      const subject = hash("privacy-acl:" + value.org);
      sql(`set role service_role;
        insert into public.meta_privacy_subjects(subject_hash,app_id,cutoff_at,status) values('${subject}','${APP}',now(),'completed');
        insert into public.meta_privacy_targets(subject_hash,organization_id,connection_id) values('${subject}','${value.org}','${value.connection}');
        insert into public.meta_privacy_storage_objects(subject_hash,organization_id,publication_id,object_index) values('${subject}','${value.org}','${value.publication}',0);
        insert into public.meta_privacy_media_tombstones(organization_id,publication_id) values('${value.org}','${value.publication}');`);
    }
    const inserts = {
      meta_privacy_targets: `(subject_hash,organization_id,connection_id) values('${hash("privacy-acl:" + neighbor.org)}','${neighbor.org}','${randomUUID()}')`,
      meta_privacy_storage_objects: `(subject_hash,organization_id,publication_id,object_index) values('${hash("privacy-acl:" + neighbor.org)}','${neighbor.org}','${randomUUID()}',0)`,
      meta_privacy_media_tombstones: `(organization_id,publication_id) values('${neighbor.org}','${randomUUID()}')`,
    };
    for (const [table, insert] of Object.entries(inserts)) {
      expect(
        result<number>(
          `set role service_role;select count(*) from public.${table} where organization_id in ('${own.org}','${neighbor.org}')`,
        ),
      ).toBe(2);
      for (const actor of [own.actor, neighbor.actor]) {
        const jwt = `set role authenticated;select set_config('request.jwt.claims','{"sub":"${actor}"}',false);`;
        for (const org of [own.org, neighbor.org])
          denied(
            `${jwt}select count(*) from public.${table} where organization_id='${org}'`,
            "permission denied",
          );
        for (const mutation of [
          `insert into public.${table}${insert}`,
          `update public.${table} set organization_id='${neighbor.org}' where organization_id='${own.org}'`,
          `delete from public.${table} where organization_id='${neighbor.org}'`,
        ])
          denied(jwt + mutation, "permission denied");
      }
      expect(
        result<number>(
          `set role service_role;select count(*) from public.${table} where organization_id in ('${own.org}','${neighbor.org}')`,
        ),
      ).toBe(2);
    }
  });

  it("revokes tokens immediately and fences an already dispatched worker", () => {
    const value = seed();
    const operation = reserve(value);
    const execution = result<{ fence: number }>(
      `select public.fn_meta_operation_claim('${operation}','native-worker',90)`,
    );
    expect(
      sql(
        `select public.fn_meta_operation_begin_dispatch('${value.org}','${operation}','native-worker',${execution.fence})`,
      ),
    ).toBe("t");
    request(value);
    expect(
      sql(
        `select status||':'||(oauth_access_token_encrypted is null)::text from public.meta_connections where id='${value.connection}'`,
      ),
    ).toBe("revoked:true");
    expect(
      sql(
        `select bool_and(not selected and status='revoked' and page_access_token_encrypted is null) from public.meta_asset_grants where connection_id='${value.connection}'`,
      ),
    ).toBe("t");
    expect(sql(`select status from public.meta_operations where id='${operation}'`)).toBe(
      "uncertain",
    );
    expect(
      sql(
        `select public.fn_meta_operation_checkpoint('${value.org}','${operation}','native-worker',${execution.fence},'succeeded','done','{}','{}',null,null,null)`,
      ),
    ).toBe("f");
    expect(sql(`select public.fn_meta_operation_authorized('${operation}')`)).toBe("f");
    finish(claim());
    expect(sql(`select count(*) from public.meta_operations where id='${operation}'`)).toBe("0");
    expect(
      sql(
        `select count(*) from public.event_log where entity_kind='meta_operation' and entity_id='${operation}'`,
      ),
    ).toBe("0");
  });

  it("keeps an opaque code stable on replay and never reports success before copied-media ACK", () => {
    const value = seed();
    const digest = hash(value.remote);
    const first = request(value, "data_deletion", digest);
    const replay = request(value, "data_deletion", digest, hash("replacement-code"));
    expect(replay.request_id).toBe(first.request_id);
    expect(
      sql(`select public.fn_decrypt_oauth('${replay.confirmation_code_encrypted}'::bytea)`),
    ).toBe(hash("opaque:" + digest));
    const lease = claim();
    const current = step(lease);
    expect(current.storage_objects).toHaveLength(10);
    expect(current.status).toBe("processing");
    expect(
      sql(`select status from public.meta_privacy_requests where id='${first.request_id}'`),
    ).toBe("processing");
    expect(step(lease).storage_objects).toEqual(current.storage_objects);
    for (const object of current.storage_objects)
      expect(object.path).toBe(
        `${value.org}/instagram/publications/${value.publication}/${object.index}.jpg`,
      );
    finish(lease, current);
    expect(
      sql(
        `select count(*) from public.meta_privacy_targets where connection_id='${value.connection}'`,
      ),
    ).toBe("0");
    expect(
      sql(
        `select count(*) from public.meta_privacy_storage_objects where organization_id='${value.org}'`,
      ),
    ).toBe("0");
  });

  it("preserves independent grants, shared assets, Studio originals, Zernio and Auth", () => {
    const value = seed(true);
    request(value);
    finish(claim());
    expect(sql(`select count(*) from public.meta_connections where id='${value.connection}'`)).toBe(
      "0",
    );
    expect(sql(`select status from public.meta_connections where id='${value.neighbor}'`)).toBe(
      "healthy",
    );
    expect(
      sql(`select count(*) from public.meta_assets where organization_id='${value.org}'`),
    ).toBe("2");
    expect(
      sql(`select count(*) from public.meta_asset_grants where connection_id='${value.neighbor}'`),
    ).toBe("2");
    expect(
      sql(`select caption from public.instagram_studio_items where id='${value.original}'`),
    ).toBe("Original Studio copy");
    expect(
      sql(
        `select caption from public.instagram_publications where organization_id='${value.org}' and provider='zernio'`,
      ),
    ).toBe("Legacy retained");
    expect(sql(`select count(*) from auth.users where id='${value.actor}'`)).toBe("1");
  });

  it("completes all subject receipts only after their shared cleanup finishes", () => {
    const value = seed();
    const a = request(value, "deauthorization");
    const b = request(value, "data_deletion");
    const lease = claim();
    const current = step(lease);
    expect(
      sql(
        `select count(*) from public.meta_privacy_requests where id in ('${a.request_id}','${b.request_id}') and status='completed'`,
      ),
    ).toBe("0");
    finish(lease, current);
    expect(
      sql(
        `select count(*) from public.meta_privacy_requests where id in ('${a.request_id}','${b.request_id}') and status='completed'`,
      ),
    ).toBe("2");
  });

  it("rejects stale leases and cross-subject storage ACKs", () => {
    const a = seed();
    const b = seed();
    request(a);
    request(b);
    const old = claim();
    step(old);
    sql(
      `update public.meta_privacy_requests set lease_until=now()-interval '1 second' where id='${old.id}'`,
    );
    const next = claim();
    expect(next.id).toBe(old.id);
    expect(next.fence).toBeGreaterThan(old.fence);
    denied(
      `select public.fn_meta_privacy_step('${old.id}','${worker}',${old.fence},'{}',100)`,
      "meta_privacy_lease_lost",
    );
    const second = claim();
    const foreign = step(second).storage_objects[0]!;
    denied(
      `select public.fn_meta_privacy_step('${next.id}','${worker}',${next.fence},array['${foreign.id}'::uuid],100)`,
      "meta_privacy_ack_invalid",
    );
    finish(next);
    finish(second);
  });

  it("blocks old OAuth after cleanup while allowing fresh consent", () => {
    const value = seed(false, false);
    request(value);
    expect(() => attempt(value, value.remote)).toThrow("meta_privacy_authorization_unavailable");
    finish(claim());
    expect(() => attempt(value, value.remote, true)).toThrow(
      "meta_privacy_authorization_unavailable",
    );
    const fresh = attempt(value, value.remote);
    const finalized = result<{ connection_id: string; status: string }>(
      `select public.fn_meta_oauth_finalize('${value.org}','${value.actor}','privacy-session','${fresh.ticket}')`,
    );
    expect(finalized.status).toBe("selection_pending");
    expect(
      sql(
        `select remote_actor_id from public.meta_connections where id='${finalized.connection_id}'`,
      ),
    ).toBe(value.remote);
  });

  it("rejects late encrypted OAuth results for a subject without any prior connection", () => {
    const value = seed(false, false);
    const remote = value.remote + "77";
    const id = randomUUID();
    const stateHash = hash(id + "state");
    const cookieHash = hash(id + "cookie");
    sql(`insert into public.meta_oauth_attempts(id,organization_id,actor_id,auth_session_id,app_id,config_id,config_revision,state_hash,cookie_hash,status,expires_at)
      select '${id}','${value.org}','${value.actor}','privacy-session',app_id,config_id,config_revision,'${stateHash}','${cookieHash}','pending',now()+interval '10 minutes'
      from public.platform_meta_app where id=1;`);
    const callback = result<{ callback_claim_id: string }>(
      `select public.fn_meta_oauth_claim('${stateHash}','${cookieHash}')`,
    );
    request({ ...value, remote });
    const pending = json({
      remote_actor_id: remote,
      access_token: "late-pending-token",
      scopes: [],
      granular_scopes: [],
      assets: [],
    });
    const store = `select public.fn_meta_oauth_store_result('${id}','${callback.callback_claim_id}','${hash(id + "ticket")}',public.fn_encrypt_oauth(${pending}::text))`;
    denied(store, "meta_privacy_authorization_unavailable");
    finish(claim());
    denied(store, "meta_privacy_authorization_unavailable");
    expect(
      sql(
        `select status||':'||(pending_result_encrypted is null)::text from public.meta_oauth_attempts where id='${id}'`,
      ),
    ).toBe("exchanging:true");
  });

  it("erases a matching pending result without deleting a different user's ready attempt", () => {
    const value = seed(false, false);
    const own = attempt(value, value.remote);
    const other = attempt(value, value.remote + "8");
    request(value);
    expect(sql(`select count(*) from public.meta_oauth_attempts where id='${own.id}'`)).toBe("0");
    expect(
      sql(
        `select status||':'||(pending_result_encrypted is not null)::text from public.meta_oauth_attempts where id='${other.id}'`,
      ),
    ).toBe("ready:true");
    finish(claim());
    expect(sql(`select status from public.meta_oauth_attempts where id='${other.id}'`)).toBe(
      "ready",
    );
  });

  it("requires native publication attribution and derives draft attribution from its creative", () => {
    const value = seed(false, false);
    denied(
      `insert into public.instagram_publications(id,organization_id,account_id,item_ids,format,provider,meta_asset_id,requested_by)
      values('${randomUUID()}','${value.org}','remote',array['${value.original}'::uuid],'feed','meta','${value.asset}','${value.actor}')`,
      "meta_publication_connection_required",
    );
    const draft = randomUUID();
    const account = randomUUID();
    sql(`insert into public.meta_assets(id,organization_id,kind,external_id,name,currency) values('${account}','${value.org}','ad_account','${value.remote}3','Ads','BRL');
      insert into public.meta_asset_grants(organization_id,connection_id,asset_id) values('${value.org}','${value.connection}','${account}');
      insert into public.meta_campaign_drafts(id,organization_id,created_by,ad_account_asset_id,page_asset_id,name,objective,daily_budget_cents,currency,creative)
      values('${draft}','${value.org}','${value.actor}','${account}','${value.page}','Derived draft','OUTCOME_TRAFFIC',1000,'BRL',${json({ connection_id: value.connection, studio_item_id: value.original })});`);
    expect(
      sql(`select meta_connection_id from public.meta_campaign_drafts where id='${draft}'`),
    ).toBe(value.connection);
    request(value);
    finish(claim());
    expect(sql(`select count(*) from public.meta_campaign_drafts where id='${draft}'`)).toBe("0");
  });

  it("accepts provider removal while native features are disabled and rejects a changed app", () => {
    const value = seed(false, false);
    sql(
      "update public.platform_meta_app set native_enabled=false,instagram_enabled=false,ads_enabled=false where id=1",
    );
    request(value);
    finish(claim());
    denied(
      `select public.fn_meta_privacy_request('441799999','${value.remote}','data_deletion','${hash("other-app")}','${hash("other-code")}',now())`,
      "meta_privacy_app_changed",
    );
    sql(
      "update public.platform_meta_app set native_enabled=true,instagram_enabled=true,ads_enabled=true where id=1",
    );
  });

  it("does not wait for a publication holding the shared preparation lock", async () => {
    const value = seed();
    request(value);
    const lease = claim();
    const lockName = `meta-privacy-connection:${value.connection}`;
    const command = `select pg_advisory_lock_shared(hashtextextended('${lockName}',0));select pg_sleep(2);select pg_advisory_unlock_shared(hashtextextended('${lockName}',0));`;
    const pending = promisify(execFile)("docker", [
      "exec",
      process.env.TEST_DB_CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-c",
      command,
    ]);
    for (let tries = 0; tries < 20; tries++) {
      const unavailable = sql(
        `select case when pg_try_advisory_lock(hashtextextended('${lockName}',0)) then pg_advisory_unlock(hashtextextended('${lockName}',0)) else false end`,
      );
      if (unavailable === "f") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const started = Date.now();
    const current = step(lease);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(current.more).toBe(true);
    expect(current.storage_objects).toEqual([]);
    expect(
      sql(`select count(*) from public.instagram_publications where id='${value.publication}'`),
    ).toBe("1");
    await pending;
    finish(lease);
  });

  it("serializes against a Storage metadata transaction and blocks later resurrection", async () => {
    const value = seed();
    request(value);
    const lease = claim();
    const path = `${value.org}/instagram/publications/${value.publication}/0.jpg`;
    const lockName = `meta-privacy-publication:${value.org}:${value.publication}`;
    const command = `begin;insert into storage.objects(bucket_id,name) values('whatsapp-media','${path}');select pg_sleep(2);commit;`;
    const uploading = promisify(execFile)("docker", [
      "exec",
      process.env.TEST_DB_CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-c",
      command,
    ]);
    let held = false;
    for (let tries = 0; tries < 20; tries++) {
      if (
        sql(
          `select case when pg_try_advisory_lock(hashtextextended('${lockName}',0)) then pg_advisory_unlock(hashtextextended('${lockName}',0)) else false end`,
        ) === "f"
      ) {
        held = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(held).toBe(true);
    const busy = step(lease);
    expect(busy.more).toBe(true);
    expect(busy.storage_objects).toEqual([]);
    expect(
      sql(`select count(*) from public.instagram_publications where id='${value.publication}'`),
    ).toBe("1");
    await uploading;
    const ready = step(lease);
    expect(ready.storage_objects).toHaveLength(10);
    expect(
      sql(
        `select count(*) from public.meta_privacy_media_tombstones where organization_id='${value.org}' and publication_id='${value.publication}'`,
      ),
    ).toBe("1");
    denied(
      `insert into storage.objects(bucket_id,name) values('whatsapp-media','${value.org}/instagram/publications/${value.publication}/1.jpg')`,
      "meta_publication_erased",
    );
    denied(
      `update storage.objects set metadata='{"late":true}' where bucket_id='whatsapp-media' and name='${path}'`,
      "meta_publication_erased",
    );
    sql(`delete from storage.objects where bucket_id='whatsapp-media' and name='${path}';
      insert into storage.objects(bucket_id,name) values('whatsapp-media','${value.org}/instagram/original-independent.jpg');`);
    finish(lease, ready);
    expect(
      sql(
        `select count(*) from storage.objects where name='${value.org}/instagram/original-independent.jpg'`,
      ),
    ).toBe("1");
    denied(
      `insert into storage.objects(bucket_id,name) values('whatsapp-media','${path}')`,
      "meta_publication_erased",
    );
  });

  it("keeps an uncertain physical upload pending until explicit reconciliation", () => {
    const value = seed();
    sql(
      `update public.instagram_publications set meta_media_cleanup_uncertain=true where id='${value.publication}'`,
    );
    const receipt = request(value);
    const lease = claim();
    const uncertain = step(lease);
    expect(uncertain).toEqual({ status: "pending", more: true, storage_objects: [] });
    expect(
      sql(
        `select status||':'||(lease_owner is null)::text from public.meta_privacy_requests where id='${receipt.request_id}'`,
      ),
    ).toBe("pending:true");
    expect(
      sql(
        `select count(*) from public.instagram_publications where id='${value.publication}' and meta_media_cleanup_uncertain`,
      ),
    ).toBe("1");
    expect(
      sql(
        `select count(*) from public.meta_privacy_targets where connection_id='${value.connection}'`,
      ),
    ).toBe("1");
    expect(sql(`select status from public.meta_connections where id='${value.connection}'`)).toBe(
      "revoked",
    );
    denied(
      `select public.fn_meta_privacy_step('${lease.id}','${worker}',${lease.fence},'{}',100)`,
      "meta_privacy_lease_lost",
    );
    // This simulates a trusted operator's independently verified reconciliation,
    // never automatic success merely because a timeout or retry interval passed.
    sql(`update public.instagram_publications set meta_media_cleanup_uncertain=false where id='${value.publication}';
      update public.meta_privacy_requests set retry_at=now() where id='${receipt.request_id}';`);
    finish(claim());
  });

  it("rejects partial/incompatible installation and preserves compatible forward function bodies", () => {
    expect(state()).toBe("ready");
    expect(sql(nativeContract)).toBe("ready");
    for (const mutation of [
      "alter table public.meta_privacy_requests drop column confirmation_code_encrypted;",
      "alter table public.meta_privacy_requests disable row level security;",
      "grant select on public.meta_privacy_targets to authenticated;",
      "alter table public.instagram_publications drop constraint instagram_publications_meta_connection_fk;",
      "drop index public.meta_privacy_requests_due_idx;",
      "alter table public.meta_connections disable trigger trg_meta_privacy_connection_guard;",
      "alter table public.meta_privacy_storage_objects drop constraint meta_privacy_storage_objects_object_index_check;",
      "alter table public.meta_privacy_requests drop column retry_at;",
      "alter table storage.objects disable trigger trg_meta_privacy_storage_fence;",
    ])
      expect(state(mutation)).toBe("incompatible");
    expect(state("drop function public.fn_meta_privacy_claim(text,integer);")).toBe("partial");
    expect(
      state("alter table public.instagram_publications drop column meta_media_cleanup_uncertain;"),
    ).toBe("partial");
    expect(state("alter table public.meta_privacy_requests add column future_metadata text;")).toBe(
      "ready",
    );
    expect(
      state(
        "create or replace function public.fn_meta_privacy_claim(p_worker_id text,p_lease_seconds integer default 90) returns jsonb language sql security invoker set search_path='' as $$select null::jsonb$$;",
      ),
    ).toBe("ready");
  });

  it("reapplying 0417 preserves a marked forward core body", () => {
    const signature = "public.fn_meta_operation_authorized(uuid)";
    const output =
      sql(`begin;create or replace function public.fn_meta_operation_authorized(p_operation_id uuid) returns boolean language sql stable security invoker set search_path='' as $$select false$$;
      comment on function ${signature} is 'meta-privacy-0417-v2';\n${migration}\nselect pg_get_functiondef('${signature}'::regprocedure) like '%select false%';rollback;`);
    expect(output.split("\n").at(-2)).toBe("t");
  });
});
