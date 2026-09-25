-- Resultado semântico do Jev: apenas rótulos controlados, nunca texto da mensagem.
create table if not exists public.whatsapp_history_analysis (
  message_id uuid primary key references public.whatsapp_history_messages(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intent text not null check (intent in ('preco','informacao','agendamento','suporte','reclamacao','outro','incerto','ignorado')),
  objection text not null check (objection in ('preco','prazo','confianca','adequacao','nenhuma','incerto','ignorado')),
  confidence real not null default 0 check (confidence between 0 and 1),
  cost_usd numeric(12,8) not null default 0,
  analyzed_at timestamptz not null default now()
);
create index if not exists whatsapp_history_analysis_org_idx on public.whatsapp_history_analysis(organization_id,intent);
alter table public.whatsapp_history_analysis enable row level security;
revoke all on public.whatsapp_history_analysis from anon,authenticated;
grant select on public.whatsapp_history_analysis to authenticated;
grant all on public.whatsapp_history_analysis to service_role;
drop policy if exists tenant_isolation_whatsapp_history_analysis on public.whatsapp_history_analysis;
create policy tenant_isolation_whatsapp_history_analysis on public.whatsapp_history_analysis for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id,'manager'));

create or replace function public.fn_validar_whatsapp_history_analysis() returns trigger language plpgsql set search_path=public as $$
begin
  if not exists(select 1 from public.whatsapp_history_messages h
    where h.id=new.message_id and h.organization_id=new.organization_id) then
    raise exception 'history_analysis_tenant_mismatch' using errcode='23514';
  end if;
  return new;
end;$$;
revoke all on function public.fn_validar_whatsapp_history_analysis() from public,anon,authenticated;
drop trigger if exists trg_validar_whatsapp_history_analysis on public.whatsapp_history_analysis;
create trigger trg_validar_whatsapp_history_analysis before insert or update on public.whatsapp_history_analysis
  for each row execute function public.fn_validar_whatsapp_history_analysis();

-- Somente o cron com service_role lê os pendentes. A view respeita RLS do chamador.
create or replace view public.whatsapp_history_pending_analysis with (security_invoker=true) as
  select h.id,h.organization_id,h.contact_id,h.body,h.imported_at
  from public.whatsapp_history_messages h
  left join public.whatsapp_history_analysis a on a.message_id=h.id
  where h.direction='inbound' and a.message_id is null;
revoke all on public.whatsapp_history_pending_analysis from anon,authenticated;
grant select on public.whatsapp_history_pending_analysis to service_role;
