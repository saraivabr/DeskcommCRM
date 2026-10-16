import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOV_CONTACT_1, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const dir = mkdtempSync(join(tmpdir(), "release-db-"));
const CONNECTION = "42430000-0000-4000-8000-000000000001";
let preflight: string;
let apply: string;
let verify: string;
function atomic(script: string): string {
  return execFileSync("docker", ["exec", "-i", process.env.TEST_DB_CONTAINER!, "psql",
    "-X", "-qAt", "-1", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
  { input: script, encoding: "utf8" }).trim();
}
beforeAll(() => {
  execFileSync("python3", ["scripts/build-upstream-release.py", process.cwd(), dir]);
  preflight = readFileSync(join(dir, "release-preflight.sql"), "utf8");
  apply = readFileSync(join(dir, "release-apply.sql"), "utf8");
  verify = readFileSync(join(dir, "release-verify.sql"), "utf8");
  seedGov();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.sequential("release estável: estado conhecido, transação e reaplicação com dados", () => {
  it("atualiza o contrato anterior com dados, desfaz falha intermediária e registra uma única aplicação", () => {
    // Confirm that the fresh, current baseline is also an accepted starting point.
    expect(lastLine(sql(preflight))).toBe("ready");
    sql(`
      drop index public.idx_send_ledger_contato_entregue;
      drop index public.idx_llm_calls_job_id;
      drop index public.idx_lead_checkpoints_job_id;
      drop index public.idx_lead_state_transitions_job_id;
      drop index public.event_log_processing_por_tipo_idx;
      drop view public.external_db_connections_safe;
      alter table public.external_db_connections drop column source_mode, drop column sources;
      ${readFileSync("tests/fixtures/upstream-release-previous.sql", "utf8")}
      revoke all on public.external_db_connections_safe from anon;
      grant select on public.external_db_connections_safe to authenticated;
      update public.contacts set force_human=true where id='${GOV_CONTACT_1}';
      insert into public.external_db_connections
        (id,organization_id,label,host,database_name,username,password_encrypted,password_iv,password_tag)
        values ('${CONNECTION}','${GOV_ORG}','Existing source','example.invalid','test','reader','\\x00','\\x00','\\x00');
    `);
    expect(lastLine(sql(preflight))).toBe("ready");
    expect(() => atomic(apply.replace("insert into escreveai_ops.schema_releases", "select 1/0;\ninsert into escreveai_ops.schema_releases"))).toThrow();
    expect(lastLine(sql("select to_regclass('escreveai_ops.schema_releases') is null;"))).toBe("t");
    expect(lastLine(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='external_db_connections' and column_name='source_mode';"))).toBe("0");
    expect(lastLine(sql(`select force_human from public.contacts where id='${GOV_CONTACT_1}';`))).toBe("t");
    expect(lastLine(atomic(apply))).toBe("ready");
    expect(lastLine(sql(verify))).toBe("ready");
    expect(lastLine(sql(`select source_mode || '|' || sources::text from public.external_db_connections where id='${CONNECTION}';`))).toBe("all|[]");
    const before = lastLine(sql("select checksum || '|' || applied_at::text from escreveai_ops.schema_releases;"));
    expect(lastLine(atomic(apply))).toBe("ready");
    expect(lastLine(sql("select checksum || '|' || applied_at::text from escreveai_ops.schema_releases;"))).toBe(before);
    expect(lastLine(sql("select count(*) from escreveai_ops.schema_releases;"))).toBe("1");
  });

  it.each([
    ["corpo desconhecido", "create or replace function public.fn_attendant_metrics(p_org uuid,p_from timestamptz,p_to timestamptz,p_owner uuid default null) returns jsonb language sql stable set search_path=public as $$ select '{}'::jsonb $$;"],
    ["acesso anon", "grant execute on function public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid) to anon;"],
    ["índice incompatível", "drop index public.idx_llm_calls_job_id; create index idx_llm_calls_job_id on public.llm_calls(organization_id);"],
    ["view sem RLS invoker", "alter view public.external_db_connections_safe set (security_invoker=false);"],
    ["default alterado", "alter table public.external_db_connections alter column source_mode set default 'list';"],
    ["journal exposto", "grant usage on schema escreveai_ops to service_role; grant select on escreveai_ops.schema_releases to service_role;"],
    ["checksum diferente", "update escreveai_ops.schema_releases set checksum=repeat('0',64);"],
  ])("recusa %s sem adotar ou sobrescrever o estado", (_name, sabotage) => {
    // ON_ERROR_STOP closes the connection, rolling back this test-only sabotage.
    expect(() => sql(`begin; ${sabotage}\n${preflight}\nrollback;`)).toThrow();
    expect(lastLine(sql(verify))).toBe("ready");
  });
});
