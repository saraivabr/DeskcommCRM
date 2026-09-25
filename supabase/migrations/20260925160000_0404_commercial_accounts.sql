-- Explicit, closed-beta classification. Existing organizations are not converted.
create table if not exists public.org_commercial_accounts (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 classification text not null default 'legacy_unclassified' check (classification in ('internal','demo','courtesy','external_contract','free_public','paid','legacy_unclassified')),
 free_enabled boolean not null default false,
 free_seats integer check (free_seats>0),
 free_channels integer check (free_channels>=0),
 free_agents integer check (free_agents>=0),
 free_ai_credit_cents integer check (free_ai_credit_cents>0),
 free_ai_usd_to_brl_rate numeric check (free_ai_usd_to_brl_rate>0 and free_ai_usd_to_brl_rate<'Infinity'::numeric),
 free_period_start timestamptz,
 free_period_end timestamptz,
 quota_revision bigint not null default 0,
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id),
 check (not free_enabled or (classification='free_public' and free_seats is not null and free_channels is not null and free_agents is not null and free_ai_credit_cents is not null and free_ai_usd_to_brl_rate is not null and free_period_start is not null and free_period_end is not null and isfinite(free_period_start) and isfinite(free_period_end) and free_period_start<free_period_end))
);
alter table public.org_commercial_accounts enable row level security;
revoke all on public.org_commercial_accounts from public,anon,authenticated,service_role;
grant select,insert,update on public.org_commercial_accounts to service_role;

-- A serialization row exists even before an account is classified. A write,
-- rather than an advisory/read lock, also fences repeatable-read snapshots.
create table if not exists public.org_commercial_locks (
 organization_id uuid primary key references public.organizations(id) on delete cascade,
 revision bigint not null default 0
);
alter table public.org_commercial_locks enable row level security;
revoke all on public.org_commercial_locks from public,anon,authenticated,service_role;
-- Only security-definer quota functions write this internal mutex.

create or replace function public.fn_subscription_resource_limit()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare
  target_org uuid := new.organization_id;
  counted_new boolean;
  counted_old boolean := false;
  sub public.org_subscriptions%rowtype;
  account public.org_commercial_accounts%rowtype;
  free_account boolean := false;
  capacity integer;
  used_slots bigint;
  resource_label text;
begin
  -- Classification is service-only; confirmed provider subscriptions always win.
  insert into public.org_commercial_locks(organization_id,revision) values(target_org,1)
   on conflict(organization_id) do update set revision=org_commercial_locks.revision+1;
  select * into account from public.org_commercial_accounts where organization_id=target_org;
  free_account := coalesce(account.classification='free_public',false) and not exists(
    select 1 from public.org_subscriptions where organization_id=target_org and provider_subscription_id is not null);
  if tg_table_name='ai_agents' and free_account then
    counted_new := new.archived_at is null and new.published_version_id is not null;
    if tg_op='UPDATE' then counted_old := old.archived_at is null and old.published_version_id is not null; end if;
  elsif tg_table_name='user_organizations' then
    counted_new := new.revoked_at is null;
    if tg_op='UPDATE' then counted_old := old.revoked_at is null; end if;
  elsif tg_table_name in ('ai_agents','channel_sessions') then
    counted_new := new.archived_at is null;
    if tg_op='UPDATE' then counted_old := old.archived_at is null; end if;
  else raise exception 'unsupported_subscription_resource';
  end if;
  -- Editing an existing resource and releasing capacity must remain possible,
  -- including after downgrade, overdue payment or cancellation.
  if not counted_new then return new; end if;
  if tg_op='UPDATE' and counted_old and old.organization_id=target_org then return new; end if;

  update public.org_subscriptions set quota_revision=quota_revision+1
   where organization_id=target_org and provider_subscription_id is not null
   returning * into sub;
  if not found and not free_account then return new; end if; -- legacy stays unchanged
  if free_account then
    if not account.free_enabled or account.free_period_start>now() or account.free_period_end<=now() then
      raise exception 'Free beta indisponível. Peça ao administrador para habilitar ou renovar o período.' using errcode='P4020';
    end if;
  else

  if sub.status not in ('active','trialing') or sub.current_period_end is null or sub.current_period_end<=now() then
    raise exception 'Regularize sua assinatura para adicionar novos recursos. Seus recursos atuais foram preservados.' using errcode='P4020';
  end if;
  end if;
  if tg_table_name='ai_agents' then
    select agents into capacity from public.subscription_plan_limits where plan_id=sub.plan_id;
    if free_account then capacity:=account.free_agents; end if;
    select count(*) into used_slots from public.ai_agents where organization_id=target_org and archived_at is null and (not free_account or published_version_id is not null);
    resource_label := 'agentes';
  elsif tg_table_name='channel_sessions' then
    select channels into capacity from public.subscription_plan_limits where plan_id=sub.plan_id;
    if free_account then capacity:=account.free_channels; end if;
    select count(*) into used_slots from public.channel_sessions where organization_id=target_org and archived_at is null;
    resource_label := 'canais';
  else
    select seats into capacity from public.subscription_plan_limits where plan_id=sub.plan_id;
    if free_account then capacity:=account.free_seats; end if;
    select count(*) into used_slots from public.user_organizations where organization_id=target_org and revoked_at is null;
    resource_label := 'pessoas';
  end if;
  if capacity is null or used_slots>=capacity then
    raise exception 'Seu plano atingiu o limite de %. Gerencie sua assinatura para adicionar mais.',resource_label using errcode='P4020';
  end if;
  return new;
end;
$$;
revoke all on function public.fn_subscription_resource_limit() from public, anon, authenticated;


-- Paid capacity semantics remain unchanged. Free drafts/tests do not occupy a published slot.
drop trigger if exists subscription_agents_limit on public.ai_agents;
create trigger subscription_agents_limit before insert or update of organization_id,archived_at,published_version_id on public.ai_agents
 for each row execute function public.fn_subscription_resource_limit();
create or replace function public.fn_reserve_subscription_ai(p_org uuid,p_call uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
 s public.org_subscriptions%rowtype;
 a public.org_commercial_accounts%rowtype;
 p public.subscription_ai_periods%rowtype;
 credit numeric;
 conversion numeric;
 spent numeric;
 held numeric;
 reserve_amount numeric;
begin
 -- Same mutex as resource creation and first activation, before any subscription lock.
 insert into public.org_commercial_locks(organization_id,revision) values(p_org,1)
 on conflict(organization_id) do update set revision=org_commercial_locks.revision+1;
 select * into a from public.org_commercial_accounts where organization_id=p_org;
 -- Same serialization as resource reservations, including repeatable-read transactions.
 update public.org_subscriptions set quota_revision=quota_revision+1
 where organization_id=p_org and provider_subscription_id is not null returning * into s;
 if not found then
   if a.classification is distinct from 'free_public' then return null; end if;
   if not a.free_enabled or a.free_period_start>now() or a.free_period_end<=now() then
     raise exception 'Free beta indisponível. Peça ao administrador para habilitar ou renovar o período.' using errcode='P4021';
   end if;
   s.provider_subscription_id:='free:'||p_org::text;
   s.status:='active';
   s.current_period_start:=a.free_period_start;
   s.current_period_end:=a.free_period_end;
   credit:=a.free_ai_credit_cents;
   conversion:=a.free_ai_usd_to_brl_rate;
 else
   select ai_credit_cents,ai_usd_to_brl_rate into credit,conversion from public.subscription_plan_limits where plan_id=s.plan_id;
 end if;
 if s.status not in ('active','trialing') or s.current_period_start is null
    or s.current_period_start>now() or s.current_period_end<=now() then
   raise exception 'Sua assinatura precisa de confirmação antes de usar a franquia de IA.' using errcode='P4021';
 end if;
 if credit is null or conversion is null then
   raise exception 'Franquia de IA indisponível para este plano.' using errcode='P4021';
 end if;
 insert into public.subscription_ai_periods(organization_id,provider_subscription_id,period_start,period_end,budget_brl_cents,usd_to_brl_rate)
 values(p_org,s.provider_subscription_id,s.current_period_start,s.current_period_end,credit,conversion)
 on conflict(organization_id,provider_subscription_id,period_start) do nothing;
 update public.subscription_ai_periods set revision=revision+1
 where organization_id=p_org and provider_subscription_id=s.provider_subscription_id and period_start=s.current_period_start returning * into p;
 if exists(select 1 from public.subscription_ai_reservations where organization_id=p_org and period_id=p.id and status='unknown') then
   raise exception 'O consumo anterior de IA precisa ser conferido. Sua franquia foi preservada.' using errcode='P4021';
 end if;
 if exists(select 1 from public.subscription_ai_reservations where id=p_call) then
   raise exception 'Esta execução já possui uma reserva de IA.' using errcode='P4022';
 end if;
 select coalesce(sum(charged_brl_cents) filter(where status='settled'),0),
        coalesce(sum(reserved_brl_cents) filter(where status<>'settled'),0)
 into spent,held from public.subscription_ai_reservations where organization_id=p_org and period_id=p.id;
 reserve_amount:=least(100,p.budget_brl_cents-spent-held);
 if reserve_amount<=0 then
   raise exception 'A franquia de IA está esgotada ou reservada por atendimentos em andamento.' using errcode='P4021';
 end if;
 insert into public.subscription_ai_reservations(id,organization_id,period_id,reserved_brl_cents)
 values(p_call,p_org,p.id,reserve_amount);
 return p_call;
end $$;

revoke all on function public.fn_reserve_subscription_ai(uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_reserve_subscription_ai(uuid,uuid) to service_role;

-- Existing balances cannot be reset by moving a beta period backwards/overlapping it.
create or replace function public.fn_validate_commercial_account()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 -- Consumers hold the mutex but only READ this configuration, avoiding a reverse
 -- lock dependency with UPDATE's pre-existing row lock on this account.
 insert into public.org_commercial_locks(organization_id,revision) values(new.organization_id,1)
 on conflict(organization_id) do update set revision=org_commercial_locks.revision+1;
 if new.classification='paid' and not exists(select 1 from public.org_subscriptions where organization_id=new.organization_id and provider_subscription_id is not null) then
   raise exception 'Confirme a assinatura antes de classificar como pago.' using errcode='P4022';
 end if;
 if new.classification='free_public' and new.free_enabled then
   if exists(select 1 from public.subscription_ai_periods p where p.organization_id=new.organization_id
     and p.provider_subscription_id='free:'||new.organization_id::text
     and p.period_start<>new.free_period_start and p.period_end>new.free_period_start) then
     raise exception 'O período Free não pode sobrepor um período já utilizado.' using errcode='P4022';
   end if;
   if exists(select 1 from public.subscription_ai_periods p where p.organization_id=new.organization_id
     and p.provider_subscription_id='free:'||new.organization_id::text and p.period_start=new.free_period_start
     and p.period_end<>new.free_period_end) then
     raise exception 'Um período utilizado não pode mudar de duração.' using errcode='P4022';
   end if;
   if (select count(*) from public.user_organizations where organization_id=new.organization_id and revoked_at is null)>new.free_seats
      or (select count(*) from public.channel_sessions where organization_id=new.organization_id and archived_at is null)>new.free_channels
      or (select count(*) from public.ai_agents where organization_id=new.organization_id and archived_at is null and published_version_id is not null)>new.free_agents then
     raise exception 'Os recursos atuais excedem os limites Free configurados.' using errcode='P4022';
   end if;
 end if;
 return new;
end $$;
revoke all on function public.fn_validate_commercial_account() from public,anon,authenticated;
drop trigger if exists validate_commercial_account on public.org_commercial_accounts;
create trigger validate_commercial_account before insert or update of classification,free_enabled,free_seats,free_channels,free_agents,free_period_start,free_period_end
 on public.org_commercial_accounts for each row execute function public.fn_validate_commercial_account();
