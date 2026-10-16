import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOV_CONTACT_1, GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const dir = mkdtempSync(join(tmpdir(), "release-db-"));
const CONNECTION = "42430000-0000-4000-8000-000000000001";
const CATALOG_MODELS = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
const MODEL_IDS_SQL = CATALOG_MODELS.map((model) => `'${model}'`).join(",");
function catalogSnapshot(): { models: Record<string, unknown>[]; prices: Record<string, unknown>[] } {
  return JSON.parse(lastLine(sql(`select jsonb_build_object(
    'models', (select jsonb_agg(to_jsonb(m) order by m.model_id) from public.ai_models m where m.model_id in (${MODEL_IDS_SQL})),
    'prices', (select jsonb_agg(to_jsonb(p) order by p.model) from public.ai_pricing p where p.model in (${MODEL_IDS_SQL}))
  );`)));
}
function defaultModels(): string {
  return lastLine(sql("select coalesce(jsonb_agg(jsonb_build_array(provider,model_id) order by provider,model_id),'[]'::jsonb) from public.ai_models where is_default_for_provider;"));
}
let originalCatalog: ReturnType<typeof catalogSnapshot> | undefined;
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
  originalCatalog = catalogSnapshot();
});
afterAll(() => {
  try {
    if (originalCatalog) {
      const jsonLiteral = (rows: Record<string, unknown>[]) => `'${JSON.stringify(rows).replaceAll("'", "''")}'::jsonb`;
      sql(`begin;
        delete from public.ai_models where model_id in (${MODEL_IDS_SQL});
        delete from public.ai_pricing where model in (${MODEL_IDS_SQL});
        insert into public.ai_models select * from jsonb_populate_recordset(null::public.ai_models,${jsonLiteral(originalCatalog.models)});
        insert into public.ai_pricing select * from jsonb_populate_recordset(null::public.ai_pricing,${jsonLiteral(originalCatalog.prices)});
        commit;`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
      -- Simulate the old installation: five models absent, one locally configured.
      delete from public.ai_models where model_id in (${MODEL_IDS_SQL});
      delete from public.ai_pricing where model in (${MODEL_IDS_SQL});
      insert into public.ai_models
        (provider,model_id,display_name,context_window,input_price_per_million_cents,output_price_per_million_cents,supports_tools)
        values ('openai','gpt-6-luna','Modelo configurado pela instalação',4096,777,888,false);
      insert into public.ai_pricing (model,prompt_cents_per_million_tokens,completion_cents_per_million_tokens,notes)
        values ('gpt-6-luna',123.4,567.8,'Preço configurado pela instalação');
    `);
    const customCatalog = catalogSnapshot();
    const defaults = defaultModels();
    expect(customCatalog.models).toHaveLength(1);
    expect(customCatalog.prices).toHaveLength(1);
    expect(lastLine(sql(preflight))).toBe("ready");
    expect(() => atomic(apply.replace("insert into escreveai_ops.schema_releases", "select 1/0;\ninsert into escreveai_ops.schema_releases"))).toThrow();
    expect(lastLine(sql("select to_regclass('escreveai_ops.schema_releases') is null;"))).toBe("t");
    expect(lastLine(sql("select count(*) from information_schema.columns where table_schema='public' and table_name='external_db_connections' and column_name='source_mode';"))).toBe("0");
    expect(lastLine(sql(`select force_human from public.contacts where id='${GOV_CONTACT_1}';`))).toBe("t");
    expect(catalogSnapshot()).toEqual(customCatalog);
    expect(lastLine(atomic(apply))).toBe("ready");
    expect(lastLine(sql(verify))).toBe("ready");
    expect(lastLine(sql(`select source_mode || '|' || sources::text from public.external_db_connections where id='${CONNECTION}';`))).toBe("all|[]");
    const installedCatalog = catalogSnapshot();
    expect(installedCatalog.models).toHaveLength(6);
    expect(installedCatalog.prices).toHaveLength(6);
    expect(installedCatalog.models.find((row) => row.model_id === "gpt-6-luna")).toEqual(customCatalog.models[0]);
    expect(installedCatalog.prices.find((row) => row.model === "gpt-6-luna")).toEqual(customCatalog.prices[0]);
    for (const [provider, model, context, input, output] of [
      ["openai", "gpt-6.1-sol", 1050000, 200, 1000],
      ["openai", "gpt-6-astra", 1050000, 1000, 5000],
      ["anthropic", "claude-haiku-5-5", 1000000, 10, 50],
      ["anthropic", "claude-sonnet-5-5", 1000000, 200, 1000],
      ["anthropic", "claude-opus-5-5", 1000000, 400, 2000],
    ] as const) {
      expect(installedCatalog.models.find((row) => row.model_id === model)).toMatchObject({
        provider, context_window: context, input_price_per_million_cents: input,
        output_price_per_million_cents: output, supports_tools: true, is_default_for_provider: false,
      });
      expect(installedCatalog.prices.find((row) => row.model === model)).toMatchObject({
        prompt_cents_per_million_tokens: input, completion_cents_per_million_tokens: output,
      });
    }
    expect(defaultModels()).toBe(defaults);
    const before = lastLine(sql("select checksum || '|' || applied_at::text from escreveai_ops.schema_releases;"));
    expect(lastLine(atomic(apply))).toBe("ready");
    expect(catalogSnapshot()).toEqual(installedCatalog);
    expect(defaultModels()).toBe(defaults);
    expect(lastLine(sql("select checksum || '|' || applied_at::text from escreveai_ops.schema_releases;"))).toBe(before);
    expect(lastLine(sql("select count(*) from escreveai_ops.schema_releases;"))).toBe("1");
  });

  it.each([
    ["corpo desconhecido", "create or replace function public.fn_attendant_metrics(p_org uuid,p_from timestamptz,p_to timestamptz,p_owner uuid default null) returns jsonb language sql stable set search_path=public as $$ select '{}'::jsonb $$;"],
    ["acesso anon", "grant execute on function public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid) to anon;"],
    ["índice incompatível", "drop index public.idx_llm_calls_job_id; create index idx_llm_calls_job_id on public.llm_calls(organization_id);"],
    ["view sem RLS invoker", "alter view public.external_db_connections_safe set (security_invoker=false);"],
    ["default alterado", "alter table public.external_db_connections alter column source_mode set default 'list';"],
    ["preço com tipo incompatível", "alter table public.ai_pricing alter column prompt_cents_per_million_tokens type text using prompt_cents_per_million_tokens::text;"],
    ["catálogo sem chave de conflito", "alter table public.ai_models drop constraint ai_models_unique;"],
    ["catálogo promovendo modelo novo a padrão", "alter table public.ai_models alter column is_default_for_provider set default true;"],
    ["journal exposto", "grant usage on schema escreveai_ops to service_role; grant select on escreveai_ops.schema_releases to service_role;"],
    ["checksum diferente", "update escreveai_ops.schema_releases set checksum=repeat('0',64);"],
  ])("recusa %s sem adotar ou sobrescrever o estado", (_name, sabotage) => {
    // ON_ERROR_STOP closes the connection, rolling back this test-only sabotage.
    expect(() => sql(`begin; ${sabotage}\n${preflight}\nrollback;`)).toThrow();
    expect(lastLine(sql(verify))).toBe("ready");
  });
});
