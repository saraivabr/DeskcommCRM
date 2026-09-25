-- Diagnóstico gerado depois da importação: rascunho por conexão, nunca uma
-- instrução ativa antes da revisão de um administrador da organização.
create table if not exists public.whatsapp_history_playbook_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null unique references public.channel_sessions(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'approved')),
  content text not null check (length(content) between 1 and 10000),
  evidence jsonb not null default '[]'::jsonb,
  source_message_count integer not null check (source_message_count >= 0),
  model text not null,
  memory_entry_id uuid references public.org_memory_entries(id) on delete set null,
  generated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);
create index if not exists whatsapp_history_playbook_org_idx
  on public.whatsapp_history_playbook_drafts(organization_id, generated_at desc);
alter table public.whatsapp_history_playbook_drafts enable row level security;
revoke all on public.whatsapp_history_playbook_drafts from anon, authenticated;
grant select on public.whatsapp_history_playbook_drafts to authenticated;
grant all on public.whatsapp_history_playbook_drafts to service_role;
drop policy if exists tenant_isolation_whatsapp_history_playbook_drafts on public.whatsapp_history_playbook_drafts;
create policy tenant_isolation_whatsapp_history_playbook_drafts
  on public.whatsapp_history_playbook_drafts for select to authenticated
  using (organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager'));

create or replace function public.fn_validar_whatsapp_history_playbook_draft()
returns trigger language plpgsql set search_path=public as $$
begin
  if not exists(select 1 from public.channel_sessions s
    where s.id=new.channel_session_id and s.organization_id=new.organization_id) then
    raise exception 'history_playbook_session_tenant_mismatch' using errcode='23514';
  end if;
  if new.memory_entry_id is not null and not exists(select 1 from public.org_memory_entries e
    where e.id=new.memory_entry_id and e.organization_id=new.organization_id) then
    raise exception 'history_playbook_memory_tenant_mismatch' using errcode='23514';
  end if;
  return new;
end;$$;
revoke all on function public.fn_validar_whatsapp_history_playbook_draft() from public,anon,authenticated;
drop trigger if exists trg_validar_whatsapp_history_playbook_draft on public.whatsapp_history_playbook_drafts;
create trigger trg_validar_whatsapp_history_playbook_draft before insert or update
  on public.whatsapp_history_playbook_drafts for each row
  execute function public.fn_validar_whatsapp_history_playbook_draft();

alter table public.org_memory_entries drop constraint if exists org_memory_entries_source_check;
alter table public.org_memory_entries add constraint org_memory_entries_source_check
  check (source in ('manual', 'flywheel', 'agent', 'whatsapp_history'));
