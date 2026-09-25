-- Preserve existing organizations explicitly, only on the first installation of
-- this forward fix. Reapplying the baseline must not classify later admin or
-- integration provisioning implicitly. Existing commercial rows are untouched.
do $$
begin
 if to_regprocedure('public.fn_provision_self_service_tenant(text,text,uuid)') is null then
   insert into public.org_commercial_accounts(organization_id,classification)
   select id,'legacy_unclassified' from public.organizations
   on conflict(organization_id) do nothing;
 end if;
end $$;

-- Only the trusted self-service provisioner calls this RPC. Bootstrap, external
-- contracts and platform-admin provisioning retain their existing behavior.
create or replace function public.fn_provision_self_service_tenant(p_slug text,p_name text,p_owner uuid)
returns table(organization_id uuid,organization_slug text,provisioned boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare tenant_id uuid; tenant_slug text;
begin
 if p_slug is null or btrim(p_slug)='' or p_name is null or btrim(p_name)='' then
   raise exception 'Empresa inválida.' using errcode='22023';
 end if;
 -- Serialize repeated auth callbacks for the same verified user. The caller
 -- never supplies an owner from a request body: it comes from verified auth.
 perform 1 from auth.users where id=p_owner for update;
 if not found then raise exception 'Usuário não encontrado.' using errcode='23503'; end if;
 select o.id,o.slug::text into tenant_id,tenant_slug
 from public.user_organizations m join public.organizations o on o.id=m.organization_id
 where m.user_id=p_owner and m.revoked_at is null order by m.created_at,m.id limit 1;
 if found then return query select tenant_id,tenant_slug,false; return; end if;
 insert into public.organizations(slug,display_name,legal_name,status,created_by)
 values(p_slug,p_name,p_name,'active',p_owner) returning id,slug::text into tenant_id,tenant_slug;
 -- The initial owner is inserted before activating commercial guards, within
 -- this same transaction. No disabled-Free exception leaks to regular invites.
 insert into public.user_organizations(user_id,organization_id,role,accepted_at)
 values(p_owner,tenant_id,'admin',now());
 insert into public.org_commercial_accounts(organization_id,classification,free_enabled)
 values(tenant_id,'free_public',false);
 return query select tenant_id,tenant_slug,true;
end $$;
revoke all on function public.fn_provision_self_service_tenant(text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_provision_self_service_tenant(text,text,uuid) to service_role;

create or replace function public.fn_validate_commercial_account()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare previous public.org_commercial_accounts%rowtype;
begin
 -- Consumers hold the mutex but only READ this configuration, avoiding a reverse
 -- lock dependency with UPDATE's pre-existing row lock on this account.
 insert into public.org_commercial_locks(organization_id,revision) values(new.organization_id,1)
 on conflict(organization_id) do update set revision=org_commercial_locks.revision+1;
 -- Read the committed configuration under the same mutex, including BEFORE
 -- INSERT during UPSERT. No ledger row is required to protect an active grant.
 select * into previous from public.org_commercial_accounts where organization_id=new.organization_id;
 if previous.classification='free_public' and new.classification='free_public'
    and previous.free_period_start is not null and previous.free_period_end>now()
    and (new.free_period_start is distinct from previous.free_period_start
         or new.free_period_end is distinct from previous.free_period_end) then
   raise exception 'Aguarde o término do período atual para renovar o Free.' using errcode='P4022';
 end if;

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

notify pgrst, 'reload schema';
