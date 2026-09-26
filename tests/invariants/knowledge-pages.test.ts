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
  otherOrg = randomUUID(),
  user = randomUUID(),
  viewer = randomUUID(),
  page = randomUUID(),
  operation = randomUUID();
function input(overrides: Record<string, unknown> = {}) {
  return {
    id: page,
    title: "Política de atendimento",
    markdown: "Prazo para retorno: dois dias úteis.",
    parent_id: null,
    archived: false,
    expected_revision: 0,
    operation_id: operation,
    ...overrides,
  };
}
function save(body: Record<string, unknown>, actor = user) {
  return sql(
    `set role service_role; select public.fn_save_knowledge_page('${org}','${actor}','${JSON.stringify(body).replaceAll("'", "''")}'::jsonb);`,
  )
    .split("\n")
    .at(-1)!;
}
beforeAll(() => {
  sql(`
insert into auth.users(id,email) values('${user}','knowledge-editor@invariant.test'),('${viewer}','knowledge-viewer@invariant.test');
insert into organizations(id,slug,legal_name,display_name) values('${org}','knowledge-test','Knowledge','Knowledge'),('${otherOrg}','knowledge-other','Other','Other');
insert into user_organizations(user_id,organization_id,role) values('${user}','${org}','agent'),('${viewer}','${otherOrg}','viewer');
`);
});
describe("knowledge pages transaction", () => {
  it("creates once, retries identically and rejects stale writes", () => {
    expect(JSON.parse(save(input())).revision).toBe(1);
    expect(JSON.parse(save(input())).revision).toBe(1);
    expect(() => save(input({ operation_id: randomUUID(), title: "Stale" }))).toThrow();
    expect(() => save(input({ title: "Different retry" }))).toThrow();
  });
  it("isolates page reads and denies direct authenticated mutation", () => {
    const out = sql(
      `set role authenticated; select set_config('request.jwt.claims','{"sub":"${viewer}"}',false); select count(*) from knowledge_pages where id='${page}';`,
    );
    expect(out.split("\n").at(-1)).toBe("0");
    expect(() =>
      sql(`set role authenticated;select public.fn_save_knowledge_page('${org}','${user}','{}');`),
    ).toThrow();
    expect(() => save(input({ id: randomUUID(), operation_id: randomUUID() }), viewer)).toThrow();
  });
  it("isolates revisions and personal favorites with positive controls", () => {
    sql(
      `insert into knowledge_page_favorites(organization_id,page_id,user_id) values('${org}','${page}','${user}');`,
    );
    for (const table of ["knowledge_page_revisions", "knowledge_page_favorites"]) {
      const own = sql(
        `set role authenticated; select set_config('request.jwt.claims','{"sub":"${user}"}',false); select count(*) from ${table} where organization_id='${org}';`,
      )
        .split("\n")
        .at(-1);
      expect(Number(own)).toBeGreaterThan(0);
      const other = sql(
        `set role authenticated; select set_config('request.jwt.claims','{"sub":"${viewer}"}',false); select count(*) from ${table} where organization_id='${org}';`,
      )
        .split("\n")
        .at(-1);
      expect(other).toBe("0");
    }
  });
  it("removes archived pages from retrieval immediately", () => {
    expect(sql(`select count(*) from fn_search_knowledge_pages('${org}','atendimento',10);`)).toBe(
      "1",
    );
    expect(
      JSON.parse(save(input({ expected_revision: 1, archived: true, operation_id: randomUUID() })))
        .revision,
    ).toBe(2);
    expect(sql(`select count(*) from fn_search_knowledge_pages('${org}','atendimento',10);`)).toBe(
      "0",
    );
  });
  it("refuses activation of a stale or archived snapshot", () => {
    expect(sql(`select fn_activate_knowledge_page('${org}','${page}',1,'${randomUUID()}');`)).toBe(
      "f",
    );
  });
});
