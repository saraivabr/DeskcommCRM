import { beforeAll, describe, expect, it } from "vitest";
import { motivoDoErro, sql } from "./psql-transporte";

const a = { org: "03930000-0000-4000-8000-000000000001", user: "03930000-1000-4000-8000-000000000001", session: "03930000-2000-4000-8000-000000000001", contact: "03930000-3000-4000-8000-000000000001" };
const b = { org: "03930000-0000-4000-8000-000000000002", user: "03930000-1000-4000-8000-000000000002", session: "03930000-2000-4000-8000-000000000002", contact: "03930000-3000-4000-8000-000000000002" };

beforeAll(() => {
  for (const [label, x] of [["a", a], ["b", b]] as const) {
    sql(`insert into auth.users(id,email) values ('${x.user}','history-${label}@invariant.test') on conflict do nothing;
      insert into public.organizations(id,slug,legal_name,display_name) values ('${x.org}','history-${label}','History ${label}','History ${label}') on conflict do nothing;
      insert into public.user_organizations(user_id,organization_id,role,accepted_at) values ('${x.user}','${x.org}','manager',now()) on conflict do nothing;
      insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values ('${x.session}','${x.org}','history-${label}','\\x00'::bytea);
      insert into public.contacts(id,organization_id,display_name) values ('${x.contact}','${x.org}','Pessoa ${label}') on conflict do nothing;
      insert into public.whatsapp_history_syncs(organization_id,channel_session_id,status) values ('${x.org}','${x.session}','complete');
      insert into public.whatsapp_history_erased_chats(organization_id,salt,chat_hash) values ('${x.org}',extensions.gen_random_bytes(32),extensions.gen_random_bytes(32));
      insert into public.whatsapp_history_messages(organization_id,channel_session_id,contact_id,chat_id,external_id,direction,body,sent_at)
       values ('${x.org}','${x.session}','${x.contact}','5511999999999@c.us','msg-${label}','inbound','segredo ${label}',now());
      insert into public.whatsapp_history_analysis(message_id,organization_id,intent,objection,confidence)
       select id,organization_id,'informacao','nenhuma',0.9 from public.whatsapp_history_messages where external_id='msg-${label}';
      insert into public.whatsapp_history_playbook_drafts(organization_id,channel_session_id,content,source_message_count,model)
       values ('${x.org}','${x.session}','Rascunho ${label}',1,'test-model');`);
  }
});

describe("histórico importado isolado e redigido", () => {
  it("manager de uma organização não lê o texto da outra", () => {
    const count = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
      select count(*) from public.whatsapp_history_messages;`).trim().split("\n").at(-1);
    expect(count).toBe("1");
    const body = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
      select body from public.whatsapp_history_messages limit 1;`).trim().split("\n").at(-1);
    expect(body).toBe("segredo a");
    const overview = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
      select count(*) from public.whatsapp_history_contact_overview;`).trim().split("\n").at(-1);
    expect(overview).toBe("1");
    const analysis = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
      select count(*) from public.whatsapp_history_analysis;`).trim().split("\n").at(-1);
    expect(analysis).toBe("1");
    const syncs = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
      select count(*) from public.whatsapp_history_syncs;`).trim().split("\n").at(-1);
    expect(syncs).toBe("1");
    const playbooks = sql(`set role authenticated;
      select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
      select count(*) from public.whatsapp_history_playbook_drafts;`).trim().split("\n").at(-1);
    expect(playbooks).toBe("1");
    let erasedReadError = "";
    try {
      sql(`set role authenticated;
        select set_config('request.jwt.claims','{"sub":"${a.user}"}',false);
        select count(*) from public.whatsapp_history_erased_chats;`);
    } catch (error) { erasedReadError = motivoDoErro(error); }
    expect(erasedReadError).toMatch(/permission denied/);
  });

  it("FK de outra organização é recusada mesmo via service role", () => {
    let err = "";
    try {
      sql(`insert into public.whatsapp_history_messages(organization_id,channel_session_id,contact_id,chat_id,external_id,direction,body,sent_at)
        values ('${a.org}','${b.session}','${a.contact}','5511999999999@c.us','cross','inbound','vazamento',now());`);
    } catch (error) { err = motivoDoErro(error); }
    expect(err).toContain("history_session_tenant_mismatch");
    let analysisErr = "";
    try {
      sql(`insert into public.whatsapp_history_analysis(message_id,organization_id,intent,objection)
        select id,'${b.org}','preco','nenhuma' from public.whatsapp_history_messages where external_id='msg-a';`);
    } catch (error) { analysisErr = motivoDoErro(error); }
    expect(analysisErr).toContain("history_analysis_tenant_mismatch");
    let playbookErr = "";
    try {
      sql(`insert into public.whatsapp_history_playbook_drafts(organization_id,channel_session_id,content,source_message_count,model)
        values ('${a.org}','${b.session}','Rascunho cruzado',1,'test-model');`);
    } catch (error) { playbookErr = motivoDoErro(error); }
    expect(playbookErr).toContain("history_playbook_session_tenant_mismatch");
  });

  it("anonimizar o contato apaga o arquivo sem apagar o vizinho", () => {
    sql(`update public.contacts set is_anonymized=true,anonymized_at=now() where id='${a.contact}' and organization_id='${a.org}';`);
    expect(sql(`select count(*) from public.whatsapp_history_messages where organization_id='${a.org}';`).trim()).toBe("0");
    expect(sql(`select count(*) from public.whatsapp_history_messages where organization_id='${b.org}';`).trim()).toBe("1");
    expect(sql(`select count(*) from public.whatsapp_history_analysis where organization_id='${a.org}';`).trim()).toBe("0");
    expect(sql(`select public.fn_whatsapp_history_chat_erased('${a.org}','5511999999999@c.us');`).trim()).toBe("t");
    expect(sql(`select public.fn_whatsapp_history_chat_erased('${b.org}','5511999999999@c.us');`).trim()).toBe("f");
  });

  it("bloqueia backfill mesmo quando o chat ainda não tinha sido importado", () => {
    const id = "03930000-3000-4000-8000-000000000003";
    sql(`insert into public.contacts(id,organization_id,phone_number,display_name)
      values ('${id}','${b.org}','+5511888888888','Outro contato');
      update public.contacts set is_anonymized=true,anonymized_at=now() where id='${id}';`);
    expect(sql(`select public.fn_whatsapp_history_chat_erased('${b.org}','5511888888888@c.us');`).trim()).toBe("t");
  });
});
