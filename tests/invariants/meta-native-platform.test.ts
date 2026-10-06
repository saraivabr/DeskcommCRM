import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const org = "a4160000-0000-4000-8000-000000000001";
const otherOrg = "b4160000-0000-4000-8000-000000000001";
const actor = "a4160000-1111-4000-8000-000000000001";
const connection = "a4160000-2222-4000-8000-000000000001";
const asset = "a4160000-3333-4000-8000-000000000001";
const otherAsset = "b4160000-3333-4000-8000-000000000001";
const grant = "a4160000-4444-4000-8000-000000000001";
const appId = "416000001";
const hashes = (digit: string) => digit.repeat(64);
const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const last = (value: string) => value.split("\n").at(-1);
const deploymentContract = readFileSync("scripts/deploy-meta-native-contract.sql", "utf8");

function deploymentState(mutation = ""): string | undefined {
  return sql(`begin;${mutation}\n${deploymentContract}\nrollback;`)
    .split("\n")
    .find((line) => ["ready", "missing", "incompatible", "dependencies_missing"].includes(line));
}

function result<T>(query: string): T {
  return JSON.parse(last(sql(query)) || "null") as T;
}

function denied(query: string, message: string): void {
  let error: unknown;
  try {
    sql(query);
  } catch (failure) {
    error = failure;
  }
  expect(error, "the database must reject the write").toBeDefined();
  expect(motivoDoErro(error)).toContain(message);
}

async function concurrently(query: string): Promise<string> {
  const run = promisify(execFile);
  const psql = process.env.TEST_DB_PSQL;
  const args = psql
    ? [
        process.env.TEST_DB_CONN ?? "postgres://postgres@localhost/postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        query,
      ]
    : [
        "exec",
        process.env.TEST_DB_CONTAINER!,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        query,
      ];
  return (await run(psql ?? "docker", args)).stdout.trim();
}

const preparedPublications = new Map<string, string>();

function preparePublication(key: string): string {
  const existing = preparedPublications.get(key);
  if (existing) return existing;
  const id = randomUUID();
  sql(`insert into public.instagram_publications
    (id,organization_id,account_id,item_ids,format,caption,provider,meta_asset_id,requested_by)
    values('${id}','${org}','shared-remote-id',array['${asset}'::uuid],'feed','Synthetic publication','meta','${asset}','${actor}')`);
  preparedPublications.set(key, id);
  return id;
}

function reserve(
  key: string,
  bodyHash = hashes("a"),
  publicationId = preparePublication(key),
): string {
  return `select public.fn_meta_operation_reserve('${org}','${actor}','${connection}',
    '${asset}','${grant}',1,'instagram_publish','${key}','${bodyHash}',
    ${quote({ caption: "Synthetic publication", publication_id: publicationId })});`;
}

function createAttempt(id: string, state: string, cookie: string): void {
  sql(`insert into public.meta_oauth_attempts
    (id,organization_id,actor_id,auth_session_id,app_id,config_id,config_revision,state_hash,cookie_hash,expires_at)
    select '${id}','${org}','${actor}','synthetic-session',app_id,config_id,config_revision,
      '${hashes(state)}','${hashes(cookie)}',now()+interval '10 minutes'
    from public.platform_meta_app where id=1;`);
}

beforeAll(() => {
  sql(`
    insert into private.app_secrets(name,value)
      values('nuvemshop_oauth_key','meta-0416-synthetic-test-key-at-least-32-characters') on conflict do nothing;
    insert into public.organizations(id,slug,legal_name,display_name) values
      ('${org}','meta-native-invariant','Synthetic A','Synthetic A'),
      ('${otherOrg}','meta-native-neighbor','Synthetic B','Synthetic B');
    insert into auth.users(id,email) values('${actor}','meta-native@invariant.test');
    insert into public.user_organizations(user_id,organization_id,role,accepted_at)
      values('${actor}','${org}','admin',now());
    insert into public.platform_meta_app(id,app_id,config_id,native_enabled,instagram_enabled,ads_enabled)
      values(1,'${appId}','416000002',true,true,true)
      on conflict(id) do update set app_id=excluded.app_id,config_id=excluded.config_id,
        native_enabled=true,instagram_enabled=true,ads_enabled=true;
    insert into public.meta_connections(id,organization_id,app_id,local_actor_id,remote_actor_id,
      actor_name,oauth_access_token_encrypted,token_type,scopes,status)
      values('${connection}','${org}','${appId}','${actor}','remote-existing','Synthetic account',
        public.fn_encrypt_oauth('synthetic-meta-token'),'user',array['instagram_basic','instagram_content_publish','pages_read_engagement'],'healthy');
    insert into public.meta_assets(id,organization_id,kind,external_id,name) values
      ('a4160000-3333-4000-8000-000000000002','${org}','page','synthetic-parent','Synthetic Page'),
      ('${asset}','${org}','instagram','shared-remote-id','Synthetic account'),
      ('${otherAsset}','${otherOrg}','instagram','shared-remote-id','Neighbor account');
    update public.meta_assets set parent_page_id='a4160000-3333-4000-8000-000000000002' where id='${asset}';
    insert into public.meta_asset_grants(id,organization_id,connection_id,asset_id,selected,tasks,permissions)
      values('${grant}','${org}','${connection}','${asset}',true,array['CREATE_CONTENT'],array['instagram_basic','instagram_content_publish','pages_read_engagement']);
  `);
});

describe("Meta native tenant and credential boundaries", () => {
  const tables = [
    "meta_oauth_attempts",
    "meta_connections",
    "meta_assets",
    "meta_asset_grants",
    "meta_operations",
    "meta_campaign_drafts",
  ];

  it("denies direct browser reads and writes even with Supabase default ACLs", () => {
    for (const table of tables) {
      expect(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).toBe(
        "t",
      );
      for (const role of ["anon", "authenticated"]) {
        expect(
          sql(`select bool_and(not has_table_privilege('${role}','public.${table}',privilege))
          from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) privilege`),
        ).toBe("t");
        denied(
          `set role ${role};select set_config('request.jwt.claims','{"sub":"${actor}"}',false);select * from public.${table}`,
          "permission denied",
        );
      }
      expect(sql(`select has_table_privilege('service_role','public.${table}','SELECT')`)).toBe(
        "t",
      );
    }
  });

  it("only grants service_role access to every new RPC", () => {
    expect(
      sql(`select count(*)>8 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'fn_meta_%'`),
    ).toBe("t");
    expect(
      sql(`select bool_and(not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'fn_meta_%'`),
    ).toBe("t");
    denied(
      `set role authenticated;select public.fn_meta_oauth_claim('${hashes("a")}','${hashes("b")}')`,
      "permission denied",
    );
  });

  it("keeps the same external asset isolated by organization", () => {
    expect(
      sql("select count(*) from public.meta_assets where external_id='shared-remote-id'"),
    ).toBe("2");
    denied(
      `insert into public.meta_asset_grants(organization_id,connection_id,asset_id)
      values('${org}','${connection}','${otherAsset}')`,
      "foreign key constraint",
    );
    denied(
      `update public.meta_assets set parent_page_id='${otherAsset}' where id='${asset}'`,
      "foreign key constraint",
    );
  });

  it("stores credentials encrypted using the canonical cipher", () => {
    expect(
      sql(`select public.fn_decrypt_oauth(oauth_access_token_encrypted)='synthetic-meta-token'
      and encode(oauth_access_token_encrypted,'escape')<>'synthetic-meta-token'
      from public.meta_connections where id='${connection}'`),
    ).toBe("t");
    denied(
      `update public.meta_connections set app_id='another-app' where id='${connection}'`,
      "meta_connection_identity_immutable",
    );
  });

  it("preserves legacy Zernio publications and rejects a native cross-org target", () => {
    sql(`insert into public.instagram_publications(id,organization_id,account_id,item_ids,format)
      values('a4160000-5555-4000-8000-000000000001','${org}','legacy-account',array['${asset}'::uuid],'feed')`);
    expect(
      sql("select provider from public.instagram_publications where account_id='legacy-account'"),
    ).toBe("zernio");
    denied(
      `insert into public.instagram_publications(id,organization_id,account_id,item_ids,format,provider,meta_asset_id)
      values('a4160000-5555-4000-8000-000000000002','${org}','remote',array['${asset}'::uuid],'feed','meta','${otherAsset}')`,
      "foreign key constraint",
    );
  });

  it("configures the issuing app with CAS and preserves WhatsApp verification", () => {
    sql(`insert into public.platform_admins(user_id,granted_by,scope,reason) values('${actor}','${actor}','full','Synthetic invariant fixture');
      update public.platform_meta_app set app_secret_encrypted=public.fn_encrypt_oauth('synthetic-app-secret'),
        verify_token_encrypted=public.fn_encrypt_oauth('synthetic-whatsapp-verification') where id=1;`);
    const before = Number(sql("select config_revision from public.platform_meta_app where id=1"));
    const configure = (expected: number, changedApp = appId) =>
      `select public.fn_meta_app_configure('${changedApp}','416000002',true,true,false,'${actor}',${expected},null)`;
    expect(Number(sql(configure(before)))).toBe(before + 1);
    denied(configure(before), "meta_app_config_changed");
    denied(configure(before + 1, "416000003"), "meta_app_identity_requires_secret");
    expect(
      sql(
        "select public.fn_decrypt_oauth(verify_token_encrypted) from public.platform_meta_app where id=1",
      ),
    ).toBe("synthetic-whatsapp-verification");
    expect(
      Number(
        sql(
          `select public.fn_meta_app_configure('${appId}','416000002',true,true,true,'${actor}',${before + 1},null)`,
        ),
      ),
    ).toBe(before + 2);
  });
});

describe("Meta deployment preserves the enforced contract", () => {
  it("accepts the installed schema and compatible future function bodies", () => {
    expect(deploymentState()).toBe("ready");
    expect(
      deploymentState("alter table public.meta_connections add column compatible_future_field text;"),
    ).toBe("ready");
    expect(
      deploymentState(`create or replace function public.fn_meta_scope_granted(
        p_scopes text[],p_permissions text[],p_granular_scopes jsonb,p_scope text,
        p_external_id text,p_parent_external_id text default null
      ) returns boolean language sql stable security invoker set search_path='' as $$select false$$;`),
    ).toBe("ready");
    expect(deploymentState()).toBe("ready");
  });

  it("rejects browser, PUBLIC and column-level privileges on secret-bearing tables", () => {
    for (const mutation of [
      "grant truncate on public.meta_connections to anon;",
      "grant trigger on public.meta_connections to authenticated;",
      "grant references on public.meta_connections to public;",
      "grant select(oauth_access_token_encrypted) on public.meta_connections to public;",
      "grant execute on function public.fn_meta_operation_authorized(uuid) to public;",
    ]) {
      expect(deploymentState(mutation), mutation).toBe("incompatible");
    }
    expect(deploymentState()).toBe("ready");
  });

  it("rejects disabled or missing enforcement, mismatched defaults and provider types", () => {
    for (const mutation of [
      "drop trigger trg_meta_app_revision on public.platform_meta_app;",
      "alter table public.meta_campaign_drafts disable trigger trg_meta_draft_revision;",
      "drop trigger trg_meta_operation_intent on public.meta_operations;",
      "alter table public.meta_asset_grants disable trigger all;",
      "alter table public.platform_meta_app alter column native_enabled set default true;",
      "alter table public.instagram_publications alter column provider set default 'meta';",
      "alter table public.instagram_publications alter column provider type character varying(100);",
      "alter table public.instagram_publications alter column provider drop not null;",
      "alter table public.meta_connections drop column oauth_access_token_encrypted;",
      "alter table public.meta_operations drop column external_dispatch_started_at;",
      "alter table public.meta_operations drop column lease_owner;",
      "alter table public.meta_connections alter column token_type drop not null;",
      "alter table public.meta_connections alter column token_type type character varying(32);",
      "alter table public.meta_operations alter column retry_at drop default;",
      "alter table public.meta_operations drop constraint meta_operations_organization_id_grant_id_connection_id_ass_fkey;",
      "alter table public.meta_operations drop constraint meta_operations_organization_id_kind_operation_key_key;",
      "drop index public.instagram_publications_operation_uk;",
      "drop index public.instagram_publications_meta_unreserved_idx;",
      "alter table public.instagram_publications drop constraint instagram_publications_provider_target_check;",
    ]) {
      expect(deploymentState(mutation), mutation).toBe("incompatible");
    }
    expect(deploymentState()).toBe("ready");
  });
});

describe("Meta OAuth one-time exchange and finalization", () => {
  it("claims the same callback once under two concurrent requests", async () => {
    createAttempt("a4160000-6666-4000-8000-000000000001", "1", "2");
    const query = `select public.fn_meta_oauth_claim('${hashes("1")}','${hashes("2")}')`;
    const claims = await Promise.all([concurrently(query), concurrently(query)]);
    expect(claims.filter((value) => value !== "" && value !== "null")).toHaveLength(1);
  });

  it("rejects wrong browser, expiry and already claimed state", () => {
    createAttempt("a4160000-6666-4000-8000-000000000002", "3", "4");
    expect(
      result(`select public.fn_meta_oauth_claim('${hashes("3")}','${hashes("5")}')`),
    ).toBeNull();
    sql(
      "update public.meta_oauth_attempts set expires_at=now()-interval '1 minute' where state_hash='" +
        hashes("3") +
        "'",
    );
    expect(
      result(`select public.fn_meta_oauth_claim('${hashes("3")}','${hashes("4")}')`),
    ).toBeNull();
  });

  it("finalizes an encrypted result and consumes its ticket atomically", () => {
    const attemptId = "a4160000-6666-4000-8000-000000000003";
    createAttempt(attemptId, "6", "7");
    const claimed = result<{ callback_claim_id: string }>(
      `select public.fn_meta_oauth_claim('${hashes("6")}','${hashes("7")}')`,
    );
    const pending = {
      remote_actor_id: "remote-finalize",
      remote_actor_name: "Synthetic user",
      access_token: "synthetic-pending-token",
      token_type: "user",
      scopes: ["pages_show_list", "instagram_content_publish"],
      granular_scopes: [],
      assets: [
        {
          kind: "page",
          external_id: "synthetic-page",
          name: "Synthetic page",
          metadata: {},
          tasks: ["CREATE_CONTENT"],
          permissions: [],
          page_access_token: "synthetic-page-token",
        },
        {
          kind: "instagram",
          external_id: "synthetic-instagram",
          parent_page_external_id: "synthetic-page",
          name: "Synthetic IG",
          metadata: {},
          tasks: [],
          permissions: ["instagram_content_publish"],
        },
      ],
    };
    expect(
      sql(`select public.fn_meta_oauth_store_result('${attemptId}','${claimed.callback_claim_id}',
      '${hashes("8")}',public.fn_encrypt_oauth(${quote(pending)}::text))`),
    ).toBe("t");
    denied(
      `select public.fn_meta_oauth_finalize('${org}','${actor}','wrong-session','${hashes("8")}')`,
      "meta_oauth_finalize_invalid",
    );
    const completed = result<{ connection_id: string; status: string }>(
      `select public.fn_meta_oauth_finalize('${org}','${actor}','synthetic-session','${hashes("8")}')`,
    );
    expect(completed.status).toBe("selection_pending");
    expect(
      sql(
        `select status||':'||(pending_result_encrypted is null)::text from public.meta_oauth_attempts where id='${attemptId}'`,
      ),
    ).toBe("finalized:true");
    denied(
      `select public.fn_meta_oauth_finalize('${org}','${actor}','synthetic-session','${hashes("8")}')`,
      "meta_oauth_finalize_invalid",
    );
    expect(
      sql(
        `select count(*) from public.meta_asset_grants where connection_id='${completed.connection_id}'`,
      ),
    ).toBe("2");
    expect(
      sql(
        "select count(*) from public.meta_assets where parent_page_id is not null and external_id='synthetic-instagram'",
      ),
    ).toBe("1");
  });

  it("does not activate a result after membership revocation", () => {
    const attemptId = "a4160000-6666-4000-8000-000000000004";
    createAttempt(attemptId, "9", "a");
    const claimed = result<{ callback_claim_id: string }>(
      `select public.fn_meta_oauth_claim('${hashes("9")}','${hashes("a")}')`,
    );
    const pending = {
      remote_actor_id: "must-not-activate",
      access_token: "synthetic-token",
      token_type: "user",
      scopes: [],
      granular_scopes: [],
      assets: [],
    };
    sql(`select public.fn_meta_oauth_store_result('${attemptId}','${claimed.callback_claim_id}','${hashes("b")}',public.fn_encrypt_oauth(${quote(pending)}::text));
      update public.user_organizations set revoked_at=now() where organization_id='${org}' and user_id='${actor}'`);
    try {
      denied(
        `select public.fn_meta_oauth_finalize('${org}','${actor}','synthetic-session','${hashes("b")}')`,
        "meta_actor_forbidden",
      );
      expect(
        sql(
          "select count(*) from public.meta_connections where remote_actor_id='must-not-activate'",
        ),
      ).toBe("0");
    } finally {
      sql(
        `update public.user_organizations set revoked_at=null where organization_id='${org}' and user_id='${actor}'`,
      );
    }
  });

  it("reauthorizes the same logical connection without duplicating it", () => {
    const connectionId = sql(
      "select id from public.meta_connections where remote_actor_id='remote-finalize'",
    );
    const attemptId = "a4160000-6666-4000-8000-000000000005";
    createAttempt(attemptId, "c", "d");
    const claimed = result<{ callback_claim_id: string }>(
      `select public.fn_meta_oauth_claim('${hashes("c")}','${hashes("d")}')`,
    );
    const pending = {
      remote_actor_id: "remote-finalize",
      remote_actor_name: "Reauthorized user",
      access_token: "synthetic-replacement-token",
      token_type: "user",
      scopes: ["instagram_basic"],
      granular_scopes: [],
      assets: [],
    };
    sql(
      `select public.fn_meta_oauth_store_result('${attemptId}','${claimed.callback_claim_id}','${hashes("e")}',public.fn_encrypt_oauth(${quote(pending)}::text));`,
    );
    const finalized = result<{ connection_id: string; version: number }>(
      `select public.fn_meta_oauth_finalize('${org}','${actor}','synthetic-session','${hashes("e")}')`,
    );
    expect(finalized.connection_id).toBe(connectionId);
    expect(finalized.version).toBe(2);
    expect(
      sql("select count(*) from public.meta_connections where remote_actor_id='remote-finalize'"),
    ).toBe("1");
    expect(
      sql(
        `select count(*) from public.meta_asset_grants where connection_id='${connectionId}' and status='healthy'`,
      ),
    ).toBe("0");
  });

  it("purges encrypted results when an unfinalized return expires", () => {
    const attemptId = "a4160000-6666-4000-8000-000000000004";
    sql(
      `update public.meta_oauth_attempts set expires_at=now()-interval '1 minute' where id='${attemptId}'`,
    );
    expect(Number(sql("select public.fn_meta_expire_oauth(100)"))).toBeGreaterThan(0);
    expect(
      sql(
        `select status||':'||(pending_result_encrypted is null)::text from public.meta_oauth_attempts where id='${attemptId}'`,
      ),
    ).toBe("expired:true");
  });
});

describe("Meta durable external operation intent", () => {
  it("reserves once and rejects the same key with a different payload", async () => {
    const replies = await Promise.all([
      concurrently(reserve("concurrent-operation")),
      concurrently(reserve("concurrent-operation")),
    ]);
    const decoded = replies.map(
      (reply) => JSON.parse(reply) as { replay: boolean; operation: { id: string } },
    );
    expect(new Set(decoded.map((reply) => reply.operation.id)).size).toBe(1);
    expect(decoded.filter((reply) => reply.replay)).toHaveLength(1);
    const firstReply = decoded[0];
    if (!firstReply) throw new Error("No operation was reserved");
    const operationId = firstReply.operation.id;
    expect(
      sql(
        `select operation_id::text||':'||status from public.instagram_publications where id='${preparedPublications.get("concurrent-operation")}'`,
      ),
    ).toBe(`${operationId}:sending`);
    expect(
      sql(
        `select count(*) from public.event_log where event_type='meta.operation_requested' and entity_id='${operationId}'`,
      ),
    ).toBe("1");
    sql(
      `update public.instagram_publications set status='pending' where operation_id='${operationId}'`,
    );
    const publicationSnapshot = sql(
      `select to_jsonb(publication)::text from public.instagram_publications publication where operation_id='${operationId}'`,
    );
    expect(result<{ replay: boolean }>(reserve("concurrent-operation")).replay).toBe(true);
    expect(
      sql(
        `select to_jsonb(publication)::text from public.instagram_publications publication where operation_id='${operationId}'`,
      ),
    ).toBe(publicationSnapshot);
    expect(
      sql(
        `select count(*) from public.event_log where event_type='meta.operation_requested' and entity_id='${operationId}'`,
      ),
    ).toBe("1");
    denied(reserve("concurrent-operation", hashes("c")), "meta_idempotency_conflict");
    denied(
      `update public.meta_operations set request_payload='{}' where operation_key='concurrent-operation'`,
      "meta_operation_intent_immutable",
    );
  });

  it("rolls back operation and wake-up when the publication is not owned and prepared", () => {
    const secondActor = randomUUID();
    sql(
      `insert into auth.users(id,email) values('${secondActor}','meta-publication-other@invariant.test')`,
    );
    const cases = [
      ["wrong-org", `organization_id='${otherOrg}',meta_asset_id='${otherAsset}'`],
      ["wrong-actor", `requested_by='${secondActor}'`],
      ["wrong-asset", "meta_asset_id='a4160000-3333-4000-8000-000000000002'"],
      ["wrong-account", "account_id='different-remote-id'"],
      ["wrong-status", "status='published'"],
      ["wrong-provider", "provider='zernio',meta_asset_id=null"],
    ] as const;
    for (const [key, changes] of cases) {
      const id = preparePublication(key);
      sql(`update public.instagram_publications set ${changes} where id='${id}'`);
      const snapshot = sql(
        `select to_jsonb(publication)::text from public.instagram_publications publication where id='${id}'`,
      );
      const events = sql(
        `select count(*) from public.event_log where organization_id='${org}' and event_type='meta.operation_requested'`,
      );
      denied(reserve(key), "meta_publication_not_prepared");
      expect(
        sql(
          `select count(*) from public.meta_operations where organization_id='${org}' and operation_key='${key}'`,
        ),
      ).toBe("0");
      expect(
        sql(
          `select count(*) from public.event_log where organization_id='${org}' and event_type='meta.operation_requested'`,
        ),
      ).toBe(events);
      expect(
        sql(
          `select to_jsonb(publication)::text from public.instagram_publications publication where id='${id}'`,
        ),
      ).toBe(snapshot);
    }
    denied(reserve("invalid-publication", hashes("a"), "invalid"), "meta_publication_invalid");
    expect(
      sql("select count(*) from public.meta_operations where operation_key='invalid-publication'"),
    ).toBe("0");
  });

  it("binds a prepared publication to one operation under concurrent distinct keys", async () => {
    const publicationId = preparePublication("one-publication");
    const replies = await Promise.allSettled([
      concurrently(reserve("publication-race-a", hashes("a"), publicationId)),
      concurrently(reserve("publication-race-b", hashes("a"), publicationId)),
    ]);
    expect(replies.filter((reply) => reply.status === "fulfilled")).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === "rejected")).toHaveLength(1);
    const rejected = replies.find((reply) => reply.status === "rejected") as PromiseRejectedResult;
    expect(motivoDoErro(rejected.reason)).toContain("meta_publication_not_prepared");
    const operationId = sql(
      `select operation_id from public.instagram_publications where id='${publicationId}'`,
    );
    expect(
      sql(
        "select count(*) from public.meta_operations where operation_key in ('publication-race-a','publication-race-b')",
      ),
    ).toBe("1");
    expect(
      sql(
        `select count(*) from public.event_log where event_type='meta.operation_requested' and entity_id='${operationId}'`,
      ),
    ).toBe("1");
  });

  it("fences concurrent workers and never automatically resends an expired dispatch", async () => {
    const reserved = result<{ operation: { id: string } }>(reserve("lease-operation"));
    const operationId = reserved.operation.id;
    const claims = await Promise.all([
      concurrently(`select public.fn_meta_operation_claim('${operationId}','worker-a',90)`),
      concurrently(`select public.fn_meta_operation_claim('${operationId}','worker-b',90)`),
    ]);
    const winner = JSON.parse(claims.find((claim) => claim !== "" && claim !== "null")!) as {
      fence: number;
      lease_owner: string;
    };
    expect(claims.filter((claim) => claim !== "" && claim !== "null")).toHaveLength(1);
    expect(
      sql(
        `select public.fn_meta_operation_begin_dispatch('${org}','${operationId}','${winner.lease_owner}',${winner.fence})`,
      ),
    ).toBe("t");
    sql(
      `update public.meta_operations set lease_until=now()-interval '1 second' where id='${operationId}'`,
    );
    expect(
      result(`select public.fn_meta_operation_claim('${operationId}','worker-c',90)`),
    ).toBeNull();
    expect(sql(`select status from public.meta_operations where id='${operationId}'`)).toBe(
      "uncertain",
    );
    expect(
      sql(
        `select public.fn_meta_operation_checkpoint('${org}','${operationId}','${winner.lease_owner}',${winner.fence},'succeeded','published','{}','{}',null,null,null)`,
      ),
    ).toBe("f");
  });

  it("rejects a stale fence after a pre-dispatch lease is reclaimed", () => {
    const reserved = result<{ operation: { id: string } }>(reserve("pre-dispatch-reclaim"));
    const operationId = reserved.operation.id;
    const first = result<{ fence: number }>(
      `select public.fn_meta_operation_claim('${operationId}','first-worker',90)`,
    );
    sql(
      `update public.meta_operations set lease_until=now()-interval '1 second' where id='${operationId}'`,
    );
    const next = result<{ fence: number }>(
      `select public.fn_meta_operation_claim('${operationId}','next-worker',90)`,
    );
    expect(next.fence).toBeGreaterThan(first.fence);
    expect(
      sql(
        `select public.fn_meta_operation_begin_dispatch('${org}','${operationId}','first-worker',${first.fence})`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select public.fn_meta_operation_heartbeat('${org}','${operationId}','first-worker',${first.fence},90)`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select public.fn_meta_operation_checkpoint('${org}','${operationId}','first-worker',${first.fence},'succeeded','published','{}','{}',null,null,null)`,
      ),
    ).toBe("f");
    expect(
      sql(
        `select public.fn_meta_operation_checkpoint('${org}','${operationId}','next-worker',${next.fence},'succeeded','published','{"media_id":"synthetic-result"}','{"media_id":"synthetic-result"}',null,null,null)`,
      ),
    ).toBe("t");
  });

  it("blocks queued work after scopes or tasks are withdrawn", () => {
    const reserved = result<{ operation: { id: string } }>(reserve("scope-withdrawn"));
    sql(
      `update public.meta_connections set scopes=array['instagram_basic'] where id='${connection}'`,
    );
    try {
      expect(
        result(
          `select public.fn_meta_operation_claim('${reserved.operation.id}','scope-worker',90)`,
        ),
      ).toBeNull();
      expect(
        sql(`select status from public.meta_operations where id='${reserved.operation.id}'`),
      ).toBe("blocked");
    } finally {
      sql(
        `update public.meta_connections set scopes=array['instagram_basic','instagram_content_publish','pages_read_engagement'] where id='${connection}'`,
      );
    }
    const second = result<{ operation: { id: string } }>(reserve("task-withdrawn"));
    sql(`update public.meta_asset_grants set tasks='{}' where id='${grant}'`);
    try {
      expect(
        result(`select public.fn_meta_operation_claim('${second.operation.id}','task-worker',90)`),
      ).toBeNull();
    } finally {
      sql(`update public.meta_asset_grants set tasks=array['CREATE_CONTENT'] where id='${grant}'`);
    }
  });

  it("does not reserve a write for an ungranted granular target", () => {
    sql(
      `update public.meta_connections set granular_scopes='[{"scope":"instagram_content_publish","target_ids":["unrelated-asset"]}]' where id='${connection}'`,
    );
    try {
      denied(reserve("granular-denied"), "meta_operation_not_authorized");
      expect(
        sql("select count(*) from public.meta_operations where operation_key='granular-denied'"),
      ).toBe("0");
    } finally {
      sql(`update public.meta_connections set granular_scopes='[]' where id='${connection}'`);
    }
  });

  it("denies explicit empty granular targets and permits an absent target property", () => {
    for (const targets of ["[]", "null", '"invalid"']) {
      sql(
        `update public.meta_connections set granular_scopes='[{"scope":"instagram_content_publish","target_ids":${targets}}]' where id='${connection}'`,
      );
      try {
        denied(reserve("granular-empty-denied"), "meta_operation_not_authorized");
        expect(
          sql(
            "select count(*) from public.meta_operations where operation_key='granular-empty-denied'",
          ),
        ).toBe("0");
      } finally {
        sql(`update public.meta_connections set granular_scopes='[]' where id='${connection}'`);
      }
    }
    sql(
      `update public.meta_connections set granular_scopes='[{"scope":"instagram_content_publish"}]' where id='${connection}'`,
    );
    try {
      const allowed = result<{ operation: { id: string } }>(reserve("granular-property-absent"));
      expect(allowed.operation.id).toBeTruthy();
    } finally {
      sql(`update public.meta_connections set granular_scopes='[]' where id='${connection}'`);
    }
  });

  it("blocks new dispatch after loss of authorization", () => {
    const reserved = result<{ operation: { id: string } }>(reserve("revoked-operation"));
    sql(`update public.meta_connections set version=version+1 where id='${connection}'`);
    expect(
      result(`select public.fn_meta_operation_claim('${reserved.operation.id}','worker-d',90)`),
    ).toBeNull();
    expect(
      sql(`select status from public.meta_operations where id='${reserved.operation.id}'`),
    ).toBe("blocked");
    denied(
      `update public.meta_connections set version=1 where id='${connection}'`,
      "meta_authorization_version_regression",
    );
  });
});
