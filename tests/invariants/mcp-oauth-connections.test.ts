import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
const container = process.env.TEST_DB_CONTAINER!;
function sql(script: string) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  ).trim();
}
const org = randomUUID(),
  user = randomUUID(),
  client = randomUUID(),
  connection = randomUUID();
const resource = "https://example.test/api/mcp",
  redirect = "https://client.test/callback",
  access = "a".repeat(64);
function exchange(hash: string, kind = "code", challenge = "valid", clientId = client) {
  return sql(
    `set role service_role;select fn_mcp_exchange_grant('${hash}','${kind}','${clientId}','${redirect}','${challenge}','${resource}','${access}','refresh-${hash}');`,
  );
}
beforeAll(() => {
  sql(`
insert into auth.users(id,email)values('${user}','oauth-user@invariant.test');
insert into organizations(id,slug,legal_name,display_name)values('${org}','oauth-test','OAuth','OAuth');
insert into user_organizations(user_id,organization_id,role)values('${user}','${org}','agent');
insert into api_tokens(id,organization_id,created_by,name,prefix,token_hash,scopes)values('${connection}','${org}','${user}','Test','dsk_test',decode('${"b".repeat(64)}','hex'),'["connection:v1","role:agent","knowledge:read"]'::jsonb);
insert into mcp_oauth_clients(id,name,redirect_uris)values('${client}','Test','["${redirect}"]');
insert into mcp_connections(id,organization_id,user_id,client_id,name)values('${connection}','${org}','${user}','${client}','Test');
insert into mcp_oauth_grants(connection_id,client_id,kind,secret_hash,challenge,redirect_uri,resource,expires_at)values('${connection}','${client}','code','code','valid','${redirect}','${resource}',now()+interval '5 minutes');
`);
});
describe("OAuth grants", () => {
  it("requires exact client and PKCE without consuming rejected grants", () => {
    expect(() => exchange("code", "code", "wrong")).toThrow();
    expect(() => exchange("code", "code", "valid", randomUUID())).toThrow();
    expect(exchange("code")).toContain("knowledge:read");
  });
  it("consumes code once and rotates refresh tokens once", () => {
    expect(() => exchange("code")).toThrow();
    expect(exchange("refresh-code", "refresh")).toContain("knowledge:read");
    expect(() => exchange("refresh-code", "refresh")).toThrow();
  });
  it("rejects a removed organization member immediately", () => {
    sql(`delete from user_organizations where user_id='${user}' and organization_id='${org}';`);
    expect(() => exchange("refresh-refresh-code", "refresh")).toThrow();
    sql(
      `insert into user_organizations(user_id,organization_id,role)values('${user}','${org}','agent');`,
    );
  });
  it("keeps connection and approval records service-only even for their owner", () => {
    sql(
      `insert into mcp_action_approvals(organization_id,connection_id,user_id,tool_name,args,args_hash) values('${org}','${connection}','${user}','knowledge_archive_page','{}','test');`,
    );
    for (const table of ["mcp_connections", "mcp_action_approvals"]) {
      expect(
        Number(sql(`select count(*) from ${table} where organization_id='${org}';`)),
      ).toBeGreaterThan(0);
      expect(() =>
        sql(
          `set role authenticated; select set_config('request.jwt.claims','{"sub":"${user}"}',false); select * from ${table} where organization_id='${org}';`,
        ),
      ).toThrow();
    }
    expect(() =>
      sql(
        `set role authenticated; select set_config('request.jwt.claims','{"sub":"${user}"}',false); update mcp_action_approvals set status='approved' where organization_id='${org}';`,
      ),
    ).toThrow();
  });
  it("revokes the whole connection and hides credentials under RLS", () => {
    sql(`update mcp_connections set revoked_at=now() where id='${connection}';`);
    expect(() => exchange("refresh-refresh-code", "refresh")).toThrow();
    expect(() => sql("set role authenticated;select * from mcp_oauth_grants;")).toThrow();
  });
});
