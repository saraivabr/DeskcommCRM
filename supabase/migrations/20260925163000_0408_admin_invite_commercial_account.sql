-- A criação administrativa usada na venda por convite deve nascer classificada.
alter table public.org_commercial_accounts add column if not exists pending_owner_email text;
-- Organizações antigas, bootstrap e integrações continuam com a classificação anterior.
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now() and tenant_creation_trusted;
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (select 1 from public.organizations where id = prior.organization_id and created_by = p_actor) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;

  -- A MESMA comparação que já decidia `interface_settings`, agora com nome e
  -- guardada. Era ela que sabia a resposta e não a anotava em lugar nenhum.
  dono_e_outra_pessoa := lower(p_request->>'owner_email') is distinct from
    (select lower(email) from auth.users where id = p_actor);

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active', jsonb_build_object('plan', p_request->>'plan'), p_actor)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover)
    values (org.id, p_actor, 'admin', now(),
      case when dono_e_outra_pessoa
        then '{"preset":"completa"}'::jsonb
        else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb) end,
      dono_e_outra_pessoa);
  -- A venda por convite nasce sem franquia até pagamento ou Free liberado.
  -- A mesma transação protege criação, vínculo e classificação comercial.
  insert into public.org_commercial_accounts(organization_id, classification, free_enabled, pending_owner_email)
    values (org.id, 'free_public', false, case when dono_e_outra_pessoa then lower(btrim(p_request->>'owner_email')) else null end);
  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result, true);
  return result || jsonb_build_object('created', true);
end $$;

revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;

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

  -- The invited owner replaces the provisional creator in one transaction.
  -- The protected e-mail, not the tenant-editable membership flag, authorizes
  -- this single identity. It also works when a one-seat Free/paid plan is active.
  if tg_table_name='user_organizations' and account.pending_owner_email is not null then
    if new.role='admin' and new.invited_by is not null
       and exists(select 1 from auth.users u where u.id=new.user_id
         and lower(u.email)=account.pending_owner_email)
       and exists(select 1 from public.organizations o
         join public.user_organizations owner on owner.organization_id=o.id
         where o.id=target_org and o.created_by=new.invited_by
           and owner.user_id=new.invited_by and owner.provisional_until_handover
           and owner.revoked_at is null)
    then
      -- Transfer the existing seat before checking capacity. Rollback restores
      -- the creator if the insert fails. Direct INSERT cannot leave two seats.
      delete from public.attendant_availability av
        where av.organization_id=target_org and av.user_id=new.invited_by;
      delete from public.user_organizations owner
        where owner.organization_id=target_org and owner.user_id=new.invited_by
          and owner.provisional_until_handover and owner.revoked_at is null;
      return new;
    end if;
  end if;

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

notify pgrst, 'reload schema';
