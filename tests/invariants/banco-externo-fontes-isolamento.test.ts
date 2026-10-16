import { beforeAll, describe, expect, it } from "vitest";
import { sql, lastLine } from "./gov-helpers";

const ORG_A = "43000000-0000-4000-8000-000000000001";
const ORG_B = "43000000-0000-4000-8000-000000000002";
const ADMIN_A = "43000000-1111-4000-8000-000000000001";
const VIEWER_A = "43000000-1111-4000-8000-000000000002";
const CON_A = "43000000-2222-4000-8000-000000000001";
const CON_B = "43000000-2222-4000-8000-000000000002";
function como(user: string, query: string) {
  return lastLine(sql(`set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${user}"}', false);
    ${query}`));
}
beforeAll(() => {
  sql(`insert into auth.users (id,email) values
      ('${ADMIN_A}','fontes-admin@invariant.test'),('${VIEWER_A}','fontes-viewer@invariant.test')
      on conflict do nothing;
    insert into organizations (id,slug,legal_name,display_name) values
      ('${ORG_A}','fontes-a','Fontes A','Fontes A'),('${ORG_B}','fontes-b','Fontes B','Fontes B')
      on conflict do nothing;
    insert into user_organizations (user_id,organization_id,role,accepted_at) values
      ('${ADMIN_A}','${ORG_A}','admin',now()),('${VIEWER_A}','${ORG_A}','viewer',now())
      on conflict do nothing;
    insert into external_db_connections
      (id,organization_id,label,host,database_name,username,password_encrypted,password_iv,password_tag,source_mode,sources)
      values ('${CON_A}','${ORG_A}','Fonte A','example.invalid','test','reader','\\x00','\\x00','\\x00','list',
        '[{"schema":"public","tabela":"pedidos","colunas":["id"],"descricao":"Permitida"}]'),
      ('${CON_B}','${ORG_B}','Fonte B','example.invalid','test','reader','\\x00','\\x00','\\x00','list','[]')
      on conflict do nothing;`);
});
describe("fontes externas — RLS real e view segura", () => {
  it("viewer lê a própria seleção e nenhuma conexão de outra empresa", () => {
    expect(como(VIEWER_A, `select count(*) from external_db_connections where id='${CON_A}';`)).toBe("1");
    expect(como(VIEWER_A, `select count(*) from external_db_connections where id='${CON_B}';`)).toBe("0");
    expect(como(VIEWER_A, `select count(*) from external_db_connections_safe;`)).toBe("1");
    expect(como(VIEWER_A, `select source_mode || '|' || sources_count from external_db_connections_safe where id='${CON_A}';`)).toBe("list|1");
  });
  it("a view nunca expõe a lista completa nem a credencial", () => {
    expect(lastLine(sql(`select count(*) from information_schema.columns where table_name='external_db_connections_safe'
      and column_name in ('sources','password_encrypted','password_iv','password_tag');`))).toBe("0");
  });
  it("viewer não troca fontes; admin só altera a própria conexão", () => {
    const update = (id: string) => `with changed as (update external_db_connections set sources='[]' where id='${id}' returning id) select count(*) from changed;`;
    expect(como(VIEWER_A, update(CON_A))).toBe("0");
    expect(como(ADMIN_A, update(CON_B))).toBe("0");
    expect(como(ADMIN_A, `with changed as (update external_db_connections set source_mode='list' where id='${CON_A}' returning id) select count(*) from changed;`)).toBe("1");
  });
});
