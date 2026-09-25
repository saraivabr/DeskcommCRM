-- Classify at the source, before egress. Historical evidence is not guessed from model names.
alter table public.subscription_ai_reservations add column if not exists usage_kind text
  check (usage_kind in ('text','image','voice','other'));
create or replace function public.fn_record_subscription_ai_kind(p_org uuid,p_call uuid,p_kind text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.subscription_ai_reservations%rowtype;
begin
 if p_kind is null or p_kind not in ('text','image','voice','other') then
   raise exception 'Tipo de consumo inválido.' using errcode='P4022';
 end if;
 select * into r from public.subscription_ai_reservations
 where organization_id=p_org and id=p_call for update;
 if not found then raise exception 'Reserva não encontrada.' using errcode='P4022'; end if;
 if r.usage_kind is not null and r.usage_kind<>p_kind then
   raise exception 'Tipo de consumo já registrado.' using errcode='P4022';
 end if;
 update public.subscription_ai_reservations set usage_kind=p_kind
 where organization_id=p_org and id=p_call;
end $$;
revoke all on function public.fn_record_subscription_ai_kind(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_record_subscription_ai_kind(uuid,uuid,text) to service_role;
