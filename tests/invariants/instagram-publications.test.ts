import { beforeAll, describe, it, expect } from "vitest";
import { sql, lastLine } from "./gov-helpers";
const a = "a3990000-0000-4000-8000-000000000001",
  b = "b3990000-0000-4000-8000-000000000001",
  u = "a3990000-1111-4000-8000-000000000001";
beforeAll(() => {
  sql(
    `insert into organizations(id,slug,legal_name,display_name) values('${a}','publish-a','A','A'),('${b}','publish-b','B','B');insert into auth.users(id,email) values('${u}','publish@invariant.test');insert into user_organizations(user_id,organization_id,role,accepted_at) values('${u}','${a}','manager',now());insert into instagram_publications(id,organization_id,account_id,item_ids,format) values('${a}','${a}','account',array['${a}'::uuid],'feed'),('${b}','${b}','account',array['${b}'::uuid],'feed');`,
  );
});
describe("Instagram publication boundaries", () => {
  it("isolates receipts between tenants", () =>
    expect(
      lastLine(
        sql(
          `set role authenticated;select set_config('request.jwt.claims','{"sub":"${u}"}',false);select count(*) from instagram_publications;`,
        ),
      ),
    ).toBe("1"));
  it("does not let the browser forge publication receipts", () => {
    expect(
      sql(
        "select bool_and(not has_table_privilege('authenticated','instagram_publications',p)) from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p",
      ),
    ).toBe("t");
    expect(sql("select has_table_privilege('anon','instagram_publications','SELECT')")).toBe("f");
  });
  it("claims a logical publication only once", () =>
    expect(() =>
      sql(
        `insert into instagram_publications(id,organization_id,account_id,item_ids,format) values('${a}','${a}','account',array['${a}'::uuid],'feed')`,
      ),
    ).toThrow());
});
