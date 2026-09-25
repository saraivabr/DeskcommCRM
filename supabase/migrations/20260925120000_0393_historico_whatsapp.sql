-- Histórico lido do store NOWEB. Separado de messages: importação antiga nunca
-- acorda o dispatcher, altera a fila ou é confundida com inbound ao vivo.
create table if not exists public.whatsapp_history_syncs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid primary key references public.channel_sessions(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','complete','unsupported','failed')),
  chat_offset integer not null default 0,
  message_offset integer not null default 0,
  scan_pass integer not null default 0,
  chats_imported integer not null default 0,
  messages_imported integer not null default 0,
  error_code text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists whatsapp_history_syncs_pending_idx on public.whatsapp_history_syncs(status,updated_at);
alter table public.whatsapp_history_syncs enable row level security;
revoke all on public.whatsapp_history_syncs from anon,authenticated;
grant select on public.whatsapp_history_syncs to authenticated;
grant all on public.whatsapp_history_syncs to service_role;
drop policy if exists tenant_isolation_whatsapp_history_syncs_all on public.whatsapp_history_syncs;
create policy tenant_isolation_whatsapp_history_syncs_all on public.whatsapp_history_syncs for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));

create table if not exists public.whatsapp_history_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  chat_id text not null,
  external_id text not null,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null,
  sent_at timestamptz not null,
  imported_at timestamptz not null default now(),
  unique (organization_id,channel_session_id,external_id)
);
create index if not exists whatsapp_history_contact_idx on public.whatsapp_history_messages(organization_id,contact_id,sent_at desc);
create index if not exists whatsapp_history_chat_idx on public.whatsapp_history_messages(organization_id,chat_id,sent_at desc);
alter table public.whatsapp_history_messages enable row level security;
revoke all on public.whatsapp_history_messages from anon,authenticated;
grant select on public.whatsapp_history_messages to authenticated;
grant all on public.whatsapp_history_messages to service_role;
drop policy if exists tenant_isolation_whatsapp_history_messages_all on public.whatsapp_history_messages;
create policy tenant_isolation_whatsapp_history_messages_all on public.whatsapp_history_messages for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));

create or replace view public.whatsapp_history_contact_overview with (security_invoker=true) as
  select organization_id,contact_id,count(*)::integer as messages_count,max(sent_at) as last_sent_at
  from public.whatsapp_history_messages group by organization_id,contact_id;
revoke all on public.whatsapp_history_contact_overview from anon,authenticated;
grant select on public.whatsapp_history_contact_overview to authenticated;

create or replace function public.fn_validar_historico_whatsapp() returns trigger language plpgsql set search_path=public as $$
begin
  if not exists(select 1 from public.channel_sessions s where s.id=new.channel_session_id and s.organization_id=new.organization_id) then
    raise exception 'history_session_tenant_mismatch' using errcode='23514';
  end if;
  if tg_table_name='whatsapp_history_messages' then
    if not exists(
      select 1 from public.contacts c where c.id=new.contact_id and c.organization_id=new.organization_id and not c.is_anonymized
    ) then
      raise exception 'history_contact_unavailable' using errcode='23514';
    end if;
  end if;
  return new;
end;$$;
revoke all on function public.fn_validar_historico_whatsapp() from public,anon,authenticated;
drop trigger if exists trg_validar_historico_whatsapp_sync on public.whatsapp_history_syncs;
create trigger trg_validar_historico_whatsapp_sync before insert or update on public.whatsapp_history_syncs
  for each row execute function public.fn_validar_historico_whatsapp();
drop trigger if exists trg_validar_historico_whatsapp_message on public.whatsapp_history_messages;
create trigger trg_validar_historico_whatsapp_message before insert or update on public.whatsapp_history_messages
  for each row execute function public.fn_validar_historico_whatsapp();

-- Só o servidor vê estas impressões digitais com sal individual. Preservá-las
-- impede que um fullSync posterior recrie o arquivo de um contato apagado.
create table if not exists public.whatsapp_history_erased_chats (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  salt bytea not null,
  chat_hash bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_history_erased_chats_org_idx on public.whatsapp_history_erased_chats(organization_id);
alter table public.whatsapp_history_erased_chats enable row level security;
revoke all on public.whatsapp_history_erased_chats from anon,authenticated;
grant all on public.whatsapp_history_erased_chats to service_role;

create or replace function public.fn_whatsapp_history_chat_erased(p_org uuid,p_chat_id text)
returns boolean language sql stable security definer set search_path=public,extensions as $$
  select exists(select 1 from public.whatsapp_history_erased_chats e
    where e.organization_id=p_org and e.chat_hash=hmac(convert_to(p_chat_id,'UTF8'),e.salt,'sha256'));
$$;
revoke all on function public.fn_whatsapp_history_chat_erased(uuid,text) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_chat_erased(uuid,text) to service_role;

-- Anonimizar um contato apaga a cópia e suprime chats conhecidos antes de
-- perder telefone, LID e metadados. DELETE já usa FK cascade.
create or replace function public.fn_redigir_historico_whatsapp() returns trigger language plpgsql security definer set search_path=public,extensions as $$
begin
  if new.is_anonymized and not old.is_anonymized then
    insert into public.whatsapp_history_erased_chats(organization_id,salt,chat_hash)
    select old.organization_id,s.salt,hmac(convert_to(s.chat_id,'UTF8'),s.salt,'sha256')
    from (
      select distinct chat_id from public.whatsapp_history_messages where organization_id=old.organization_id and contact_id=old.id
      union select old.source_metadata->>'waha_chat_id' where old.source_metadata->>'waha_chat_id' is not null
      union select regexp_replace(old.phone_number,'\D','','g') || '@c.us' where old.phone_number is not null
      union select old.wa_lid || '@lid' where old.wa_lid is not null
    ) c cross join lateral (select c.chat_id,gen_random_bytes(32) as salt) s;
    delete from public.whatsapp_history_messages where organization_id=new.organization_id and contact_id=new.id;
  end if;
  return new;
end;$$;
revoke all on function public.fn_redigir_historico_whatsapp() from public,anon,authenticated;
drop trigger if exists trg_redigir_historico_whatsapp on public.contacts;
create trigger trg_redigir_historico_whatsapp after update of is_anonymized on public.contacts
  for each row execute function public.fn_redigir_historico_whatsapp();
