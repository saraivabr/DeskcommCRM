-- An active Free account may have no AI allowance while retaining its non-AI resources.
-- A reservation rejects zero credit before creating a period or calling a model.
alter table public.org_commercial_accounts
  drop constraint if exists org_commercial_accounts_free_ai_credit_cents_check;
alter table public.org_commercial_accounts
  add constraint org_commercial_accounts_free_ai_credit_cents_check
  check (free_ai_credit_cents >= 0);

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
 if credit = 0 then
   raise exception 'Esta conta Free não tem crédito de IA.' using errcode='P4021';
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
