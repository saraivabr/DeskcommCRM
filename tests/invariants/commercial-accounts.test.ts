import { readFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "./gov-helpers";
function org() {
  const id = randomUUID();
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${id}','free-beta-${id}','Beta','Beta')`,
  );
  return id;
}
function activate(id: string, credit = 100) {
  sql(`insert into org_commercial_accounts(organization_id,classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,free_ai_usd_to_brl_rate,free_period_start,free_period_end)
    values('${id}','free_public',true,1,0,0,${credit},6,now()-interval '1 day',now()+interval '1 day')`);
}
function reserve(id: string) {
  return sql(`select fn_reserve_subscription_ai('${id}','${randomUUID()}')`);
}
it("leaves legacy unmetered; explicit Free disabled fails closed", () => {
  const id = org();
  expect(reserve(id)).toBe("");
  sql(
    `insert into org_commercial_accounts(organization_id,classification) values('${id}','free_public')`,
  );
  expect(() => reserve(id)).toThrow(/Free beta indisponível/);
});
it("shares bounded reservations, blocks exhaustion and prevents resetting period", () => {
  const id = org();
  activate(id);
  expect(reserve(id)).toMatch(/^[a-f0-9-]{36}$/);
  expect(() => reserve(id)).toThrow(/esgotada/);
  expect(() =>
    sql(
      `update org_commercial_accounts set free_period_start=free_period_start+interval '1 hour' where organization_id='${id}'`,
    ),
  ).toThrow(/período atual/);
  expect(() =>
    sql(
      `update org_commercial_accounts set free_period_end=free_period_end+interval '1 hour' where organization_id='${id}'`,
    ),
  ).toThrow(/período atual/);
});
it("preserves paid allowance precedence even for explicitly disabled Free classification", () => {
  const id = org();
  sql(`insert into org_commercial_accounts(organization_id,classification) values('${id}','free_public');
    insert into org_subscriptions(organization_id,plan_id,provider_subscription_id,status,current_period_start,current_period_end)
    values('${id}','essencial','sub_${id}','active',now()-interval '1 day',now()+interval '1 day')`);
  expect(reserve(id)).toMatch(/^[a-f0-9-]{36}$/);
  expect(
    sql(`select budget_brl_cents from subscription_ai_periods where organization_id='${id}'`),
  ).toBe("3000");
});
it("Free drafts do not reserve published slots while channel creation is guarded", () => {
  const id = org();
  activate(id);
  sql(
    `insert into ai_agents(organization_id,name,system_prompt) select '${id}','Draft '||n,'Synthetic' from generate_series(1,5) n`,
  );
  expect(sql(`select count(*) from ai_agents where organization_id='${id}'`)).toBe("5");
  // Trigger precedes constraints: even a foreign/invalid publication pointer must hit the capacity guard.
  expect(() =>
    sql(
      `update ai_agents set published_version_id='${randomUUID()}' where organization_id='${id}'`,
    ),
  ).toThrow(/limite de agentes/);
});
it("commercial configuration is inaccessible to tenant roles and tenant B cannot meter tenant A", () => {
  const a = org(),
    b = org();
  activate(a);
  activate(b);
  for (const role of ["anon", "authenticated"]) {
    expect(() =>
      sql(`set role ${role}; select * from org_commercial_accounts where organization_id='${a}'`),
    ).toThrow(/permission denied/);
    expect(() =>
      sql(
        `set role ${role}; update org_commercial_accounts set free_enabled=true where organization_id='${a}'`,
      ),
    ).toThrow(/permission denied/);
    expect(() =>
      sql(`set role ${role}; select fn_reserve_subscription_ai('${a}','${randomUUID()}')`),
    ).toThrow(/permission denied/);
  }
  reserve(a);
  expect(sql(`select count(*) from subscription_ai_periods where organization_id='${b}'`)).toBe(
    "0",
  );
  expect(() => sql(`set role service_role; truncate org_commercial_accounts`)).toThrow(
    /permission denied/,
  );
});
it("publication reserves a slot and unarchiving cannot exceed it", () => {
  const id = org();
  activate(id);
  sql(`update org_commercial_accounts set free_agents=1 where organization_id='${id}'`);
  const agents = [randomUUID(), randomUUID()];
  const versions = [randomUUID(), randomUUID()];
  for (let i = 0; i < 2; i++)
    sql(`
    insert into ai_agents(id,organization_id,name,system_prompt) values('${agents[i]}','${id}','Beta ${i}','Synthetic');
    insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model)
    values('${versions[i]}','${id}','${agents[i]}',1,'Synthetic','openai','test');`);
  sql(`update ai_agents set published_version_id='${versions[0]}' where id='${agents[0]}'`);
  expect(() =>
    sql(`update ai_agents set published_version_id='${versions[1]}' where id='${agents[1]}'`),
  ).toThrow(/limite de agentes/);
  sql(`update ai_agents set archived_at=now() where id='${agents[0]}';
    update ai_agents set published_version_id='${versions[1]}' where id='${agents[1]}'`);
  expect(() => sql(`update ai_agents set archived_at=null where id='${agents[0]}'`)).toThrow(
    /limite de agentes/,
  );
  sql(`update ai_agents set published_version_id=null where id='${agents[1]}';
    update ai_agents set archived_at=null where id='${agents[0]}'`);
});

it.each(["read committed", "repeatable read"])(
  "first activation serializes against a pending legacy resource (%s)",
  async (isolation) => {
    const id = org();
    const args = [
      "exec",
      "-i",
      process.env.TEST_DB_CONTAINER!,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
    ];
    const first = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        first.kill();
        reject(new Error("legacy resource did not become pending"));
      }, 5000);
      let output = "";
      first.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("resource-pending")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      first.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const finished = new Promise<number | null>((resolve) => first.on("close", resolve));
    first.stdin.write(`begin;
    insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted)
    values('${id}',gen_random_uuid()::text,'STOPPED',decode('00','hex'));
    select 'resource-pending';
`);
    try {
      await ready;
      let activationFinished = false;
      const activating = promisify(execFile)("docker", [
        ...args,
        "-c",
        `begin isolation level ${isolation};
      set local application_name='activation-${id}';
      select count(*) from channel_sessions where organization_id='${id}';
      insert into org_commercial_accounts(organization_id,classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,free_ai_usd_to_brl_rate,free_period_start,free_period_end)
      values('${id}','free_public',true,1,0,0,100,6,now()-interval '1 day',now()+interval '1 day');commit;`,
      ]).then(
        () => {
          activationFinished = true;
          return { ok: true, error: "" };
        },
        (error) => {
          activationFinished = true;
          return { ok: false, error: String(error) };
        },
      );
      // Release T1 only after T2 is demonstrably waiting on the shared fence
      // (or has already completed, as the pre-fix race would do).
      const deadline = Date.now() + 5000;
      while (!activationFinished) {
        if (
          sql(
            `select count(*) from pg_stat_activity where application_name='activation-${id}' and wait_event_type='Lock'`,
          ) === "1"
        )
          break;
        if (Date.now() > deadline)
          throw new Error("activation did not reach the concurrency barrier");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      first.stdin.end("commit;\n\\q\n");
      expect(await finished).toBe(0);
      const result = await activating;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/excedem|could not serialize/);
      expect(
        sql(
          `select count(*) from org_commercial_accounts where organization_id='${id}' and free_enabled`,
        ),
      ).toBe("0");
      expect(sql(`select count(*) from channel_sessions where organization_id='${id}'`)).toBe("1");
    } finally {
      if (first.exitCode === null) first.kill();
    }
  },
  15000,
);

it("real tenant admin JWTs cannot read or write service-only commercial state across organizations", () => {
  const a = org(),
    b = org();
  const userA = randomUUID(),
    userB = randomUUID();
  for (const [organizationId, userId] of [
    [a, userA],
    [b, userB],
  ]) {
    sql(`insert into auth.users(id,email) values('${userId}','${userId}@invariant.test');
      insert into user_organizations(user_id,organization_id,role) values('${userId}','${organizationId}','admin')`);
    activate(organizationId!);
  }
  // Positive fixture controls: both rows really exist before testing denial.
  for (const table of ["org_commercial_accounts", "org_commercial_locks"]) {
    expect(sql(`select count(*) from ${table} where organization_id in ('${a}','${b}')`)).toBe("2");
    for (const [userId, ownOrg, otherOrg] of [
      [userA, a, b],
      [userB, b, a],
    ]) {
      const jwt = `set role authenticated; select set_config('request.jwt.claims','{"sub":"${userId}","role":"authenticated"}',false);`;
      // A real local admin is denied even locally: configuration is NOT a tenant entitlement editor.
      expect(() => sql(`${jwt} select * from ${table} where organization_id='${ownOrg}'`)).toThrow(
        /permission denied/,
      );
      expect(() =>
        sql(`${jwt} select * from ${table} where organization_id='${otherOrg}'`),
      ).toThrow(/permission denied/);
      const column =
        table === "org_commercial_accounts" ? "free_enabled=true" : "revision=revision+1";
      expect(() =>
        sql(`${jwt} update ${table} set ${column} where organization_id='${otherOrg}'`),
      ).toThrow(/permission denied/);
      expect(() => sql(`${jwt} delete from ${table} where organization_id='${otherOrg}'`)).toThrow(
        /permission denied/,
      );
    }
  }
  expect(() =>
    sql(`set role service_role; select * from org_commercial_locks where organization_id='${a}'`),
  ).toThrow(/permission denied/);
  expect(() =>
    sql(
      `set role service_role; update org_commercial_locks set revision=revision+1 where organization_id='${a}'`,
    ),
  ).toThrow(/permission denied/);
}, 20000);

it("self-service provisions its owner atomically with Free disabled and replays without a new tenant", () => {
  const owner = randomUUID();
  sql(`insert into auth.users(id,email) values('${owner}','${owner}@invariant.test')`);
  const id = sql(`set role service_role;
    select organization_id from fn_provision_self_service_tenant('signup-${owner}','Signup','${owner}')`)
    .split("\n")
    .at(-1)!;
  expect(
    sql(
      `select classification||':'||free_enabled from org_commercial_accounts where organization_id='${id}'`,
    ),
  ).toBe("free_public:false");
  expect(
    sql(
      `select count(*) from user_organizations where organization_id='${id}' and user_id='${owner}' and role='admin' and revoked_at is null`,
    ),
  ).toBe("1");
  expect(() => reserve(id)).toThrow(/Free beta indisponível/);
  expect(
    sql(
      `select organization_id||':'||provisioned from fn_provision_self_service_tenant('retry-${owner}','Retry','${owner}')`,
    ),
  ).toBe(`${id}:false`);
  expect(sql(`select count(*) from organizations where created_by='${owner}'`)).toBe("1");
  expect(() =>
    sql(`insert into channel_sessions(organization_id,waha_session_name,status,webhook_secret_encrypted)
    values('${id}',gen_random_uuid()::text,'STOPPED',decode('00','hex'))`),
  ).toThrow(/Free beta indisponível/);
});

it("self-service RPC rejects tenant callers and rolls all provisioning back if classification fails", () => {
  const owner = randomUUID();
  sql(`insert into auth.users(id,email) values('${owner}','${owner}@invariant.test')`);
  for (const role of ["anon", "authenticated"])
    expect(() =>
      sql(
        `set role ${role}; select * from fn_provision_self_service_tenant('denied-${owner}','Denied','${owner}')`,
      ),
    ).toThrow(/permission denied/);
  // Failure AFTER the org and owner inserts must roll both back.
  expect(() =>
    sql(`begin;
    create function public.test_reject_free_signup() returns trigger language plpgsql as $$begin raise exception 'classification unavailable'; end$$;
    create trigger test_reject_free_signup before insert on org_commercial_accounts for each row execute function public.test_reject_free_signup();
    select * from fn_provision_self_service_tenant('failed-${owner}','Failed','${owner}');
    commit;`),
  ).toThrow(/classification unavailable/);
  expect(sql(`select count(*) from organizations where created_by='${owner}'`)).toBe("0");
  expect(sql(`select count(*) from user_organizations where user_id='${owner}'`)).toBe("0");
});

it.each([false, true])(
  "rejects early renewal even when consumed=%s and keeps the active period",
  (consumed) => {
    const id = org();
    activate(id);
    if (consumed) reserve(id);
    const before = sql(
      `select free_period_start||'/'||free_period_end from org_commercial_accounts where organization_id='${id}'`,
    );
    expect(() =>
      sql(`update org_commercial_accounts
    set free_period_start=free_period_end,free_period_end=free_period_end+interval '1 month'
    where organization_id='${id}'`),
    ).toThrow(/período atual/);
    // The admin endpoint uses UPSERT, whose INSERT trigger must enforce the same guard.
    expect(() =>
      sql(`insert into org_commercial_accounts(organization_id,classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,free_ai_usd_to_brl_rate,free_period_start,free_period_end)
    select organization_id,classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,free_ai_usd_to_brl_rate,free_period_end,free_period_end+interval '1 month'
    from org_commercial_accounts where organization_id='${id}'
    on conflict(organization_id) do update set free_period_start=excluded.free_period_start,free_period_end=excluded.free_period_end`),
    ).toThrow(/período atual/);
    expect(
      sql(
        `select free_period_start||'/'||free_period_end from org_commercial_accounts where organization_id='${id}'`,
      ),
    ).toBe(before);
  },
);

it("renews an expired beta and allows initial activation without changing legacy provisioning", () => {
  const id = org();
  sql(`insert into org_commercial_accounts(organization_id,classification,free_enabled,free_seats,free_channels,free_agents,free_ai_credit_cents,free_ai_usd_to_brl_rate,free_period_start,free_period_end)
    values('${id}','free_public',false,1,0,0,100,6,now()-interval '2 days',now()-interval '1 day');
    update org_commercial_accounts set free_enabled=true,free_period_start=now(),free_period_end=now()+interval '1 day' where organization_id='${id}'`);
  expect(reserve(id)).toMatch(/^[a-f0-9-]{36}$/);
  const legacy = org();
  expect(reserve(legacy)).toBe("");
});

it("the first forward fix labels existing legacy accounts once and preserves every commercial choice", () => {
  const legacy = org(),
    free = org(),
    internal = org(),
    laterAdmin = randomUUID();
  activate(free);
  sql(
    `insert into org_commercial_accounts(organization_id,classification) values('${internal}','internal')`,
  );
  const before = sql(
    `select row_to_json(a) from org_commercial_accounts a where organization_id='${free}'`,
  );
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/20260925162000_0406_self_service_free_and_renewal.sql",
      import.meta.url,
    ),
    "utf8",
  );
  // Simulate first install over pre-0406 data, then reapply over a later admin
  // tenant. Everything runs in one rolled-back transaction in the isolated DB.
  const result = sql(`begin;
    drop function public.fn_provision_self_service_tenant(text,text,uuid);
    ${migration}
    select 'legacy='||classification from org_commercial_accounts where organization_id='${legacy}';
    select 'internal='||classification from org_commercial_accounts where organization_id='${internal}';
    select 'free='||row_to_json(a)::text from org_commercial_accounts a where organization_id='${free}';
    insert into organizations(id,slug,legal_name,display_name) values('${laterAdmin}','later-${laterAdmin}','Later','Later');
    ${migration}
    select 'later='||count(*) from org_commercial_accounts where organization_id='${laterAdmin}';
    rollback;`);
  expect(result).toContain("legacy=legacy_unclassified");
  expect(result).toContain("internal=internal");
  expect(result).toContain(`free=${before}`);
  expect(result).toContain("later=0");
});
