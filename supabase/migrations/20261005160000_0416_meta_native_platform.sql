-- Meta OAuth and native effects extend the existing core social/ads journeys.
-- Tokens stay in the canonical cipher; HTTP never runs in a DB transaction.
-- All tenant edges include organization_id. Service-only ACLs are deliberate:
-- ciphertext and pending OAuth results must not be exposed through PostgREST.

alter table public.platform_meta_app
  add column if not exists app_id text,
  add column if not exists config_id text,
  add column if not exists config_revision bigint not null default 1,
  add column if not exists native_enabled boolean not null default false,
  add column if not exists instagram_enabled boolean not null default false,
  add column if not exists ads_enabled boolean not null default false;

create or replace function public.fn_meta_app_revision()
returns trigger language plpgsql set search_path='' as $$
begin
  if row(new.app_id,new.config_id,new.app_secret_encrypted,new.native_enabled,new.instagram_enabled,new.ads_enabled)
    is distinct from row(old.app_id,old.config_id,old.app_secret_encrypted,old.native_enabled,old.instagram_enabled,old.ads_enabled) then
    new.config_revision:=old.config_revision+1;
  else new.config_revision:=old.config_revision; end if;
  return new;
end $$;
revoke all on function public.fn_meta_app_revision() from public,anon,authenticated;
drop trigger if exists trg_meta_app_revision on public.platform_meta_app;
create trigger trg_meta_app_revision before update on public.platform_meta_app
  for each row execute function public.fn_meta_app_revision();

create or replace function public.fn_meta_app_configure(
  p_app_id text,p_config_id text,p_native_enabled boolean,p_instagram_enabled boolean,p_ads_enabled boolean,
  p_actor_id uuid,p_expected_revision bigint,p_app_secret_encrypted bytea default null
) returns bigint language plpgsql security invoker set search_path='' as $$
declare config public.platform_meta_app; revision bigint; next_secret bytea;
begin
  if not exists(select 1 from public.platform_admins a where a.user_id=p_actor_id
    and a.revoked_at is null and a.scope='full') then
    raise exception 'platform_admin_required' using errcode='42501'; end if;
  if p_native_enabled is null or p_instagram_enabled is null or p_ads_enabled is null
    or (p_app_id is not null and p_app_id !~ '^[0-9]{3,100}$')
    or (p_config_id is not null and p_config_id !~ '^[0-9]{3,100}$') then
    raise exception 'meta_app_config_invalid' using errcode='22023'; end if;
  -- A row lock cannot serialize initial creation when the singleton is absent.
  perform pg_advisory_xact_lock(416,1);
  select * into config from public.platform_meta_app where id=1 for update;
  if coalesce(config.config_revision,0) is distinct from p_expected_revision then
    raise exception 'meta_app_config_changed' using errcode='PT409'; end if;
  if p_app_id is distinct from config.app_id and p_app_id is not null and p_app_secret_encrypted is null then
    raise exception 'meta_app_identity_requires_secret' using errcode='PT400'; end if;
  next_secret:=coalesce(p_app_secret_encrypted,config.app_secret_encrypted);
  if p_native_enabled and (p_app_id is null or p_config_id is null or next_secret is null) then
    raise exception 'meta_app_config_incomplete' using errcode='PT400'; end if;
  if p_app_secret_encrypted is not null and nullif(public.fn_decrypt_oauth(p_app_secret_encrypted),'') is null then
    raise exception 'meta_app_secret_invalid' using errcode='PT400'; end if;
  insert into public.platform_meta_app(id,app_id,config_id,native_enabled,instagram_enabled,ads_enabled,app_secret_encrypted,updated_by)
    values(1,p_app_id,p_config_id,p_native_enabled,p_instagram_enabled,p_ads_enabled,next_secret,p_actor_id)
    on conflict(id) do update set app_id=excluded.app_id,config_id=excluded.config_id,native_enabled=excluded.native_enabled,
      instagram_enabled=excluded.instagram_enabled,ads_enabled=excluded.ads_enabled,
      app_secret_encrypted=excluded.app_secret_encrypted,updated_by=excluded.updated_by
    returning config_revision into revision;
  return revision;
end $$;
revoke all on function public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea) from public,anon,authenticated;
grant execute on function public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea) to service_role;

create table if not exists public.meta_oauth_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id text not null check(length(auth_session_id) between 1 and 200),
  app_id text not null,
  config_id text not null,
  config_revision bigint not null check(config_revision>0),
  state_hash text not null unique check(state_hash ~ '^[0-9a-f]{64}$'),
  cookie_hash text not null check(cookie_hash ~ '^[0-9a-f]{64}$'),
  ticket_hash text unique check(ticket_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check(status in ('pending','exchanging','ready','finalized','failed','expired')),
  callback_claim_id uuid,
  callback_claimed_at timestamptz,
  pending_result_encrypted bytea,
  failure_code text,
  expires_at timestamptz not null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  check(status<>'ready' or (ticket_hash is not null and pending_result_encrypted is not null)),
  check(status<>'finalized' or (pending_result_encrypted is null and finalized_at is not null))
);
create index if not exists meta_oauth_attempts_org_actor_idx on public.meta_oauth_attempts(organization_id,actor_id,created_at desc);
create index if not exists meta_oauth_attempts_actor_idx on public.meta_oauth_attempts(actor_id);
create index if not exists meta_oauth_attempts_expiry_idx on public.meta_oauth_attempts(expires_at);

create table if not exists public.meta_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  app_id text not null,
  local_actor_id uuid not null references auth.users(id) on delete restrict,
  remote_actor_id text not null check(length(remote_actor_id) between 1 and 200),
  actor_name text not null default '',
  oauth_access_token_encrypted bytea,
  token_type text not null default 'user',
  token_expires_at timestamptz,
  data_access_expires_at timestamptz,
  scopes text[] not null default '{}',
  granular_scopes jsonb not null default '[]' check(jsonb_typeof(granular_scopes)='array'),
  version bigint not null default 1 check(version>0),
  status text not null default 'selection_pending' check(status in ('selection_pending','healthy','token_expired','scope_missing','revoked','disconnected','error')),
  last_validated_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  unique(organization_id,app_id,local_actor_id,remote_actor_id)
);
create index if not exists meta_connections_actor_idx on public.meta_connections(local_actor_id);
create index if not exists meta_connections_remote_identity_idx on public.meta_connections(app_id,remote_actor_id);
create index if not exists meta_connections_expiry_idx on public.meta_connections(token_expires_at)
  where status in ('healthy','selection_pending') and token_expires_at is not null;

create table if not exists public.meta_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check(kind in ('page','instagram','ad_account')),
  external_id text not null check(length(external_id) between 1 and 200),
  name text not null default '',
  parent_page_id uuid,
  currency text check(currency ~ '^[A-Z]{3}$'),
  timezone text,
  metadata jsonb not null default '{}' check(jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  unique(organization_id,kind,external_id),
  foreign key(organization_id,parent_page_id) references public.meta_assets(organization_id,id) on delete restrict,
  check(parent_page_id is null or kind='instagram')
);
create index if not exists meta_assets_parent_idx on public.meta_assets(organization_id,parent_page_id) where parent_page_id is not null;

create table if not exists public.meta_asset_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  asset_id uuid not null,
  tasks text[] not null default '{}',
  permissions text[] not null default '{}',
  page_access_token_encrypted bytea,
  selected boolean not null default false,
  status text not null default 'healthy' check(status in ('healthy','revoked')),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  unique(organization_id,id,connection_id,asset_id),
  unique(organization_id,connection_id,asset_id),
  foreign key(organization_id,connection_id) references public.meta_connections(organization_id,id) on delete cascade,
  foreign key(organization_id,asset_id) references public.meta_assets(organization_id,id) on delete restrict
);
create index if not exists meta_asset_grants_asset_idx on public.meta_asset_grants(organization_id,asset_id);

create table if not exists public.meta_campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  ad_account_asset_id uuid not null,
  page_asset_id uuid,
  instagram_asset_id uuid,
  name text not null check(length(name) between 1 and 200),
  objective text not null,
  destination_url text,
  daily_budget_cents bigint not null check(daily_budget_cents>0),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  starts_at timestamptz,
  ends_at timestamptz,
  targeting jsonb not null default '{}' check(jsonb_typeof(targeting)='object'),
  creative jsonb not null default '{}' check(jsonb_typeof(creative)='object'),
  status text not null default 'draft' check(status in ('draft','approved','submitted','archived')),
  revision bigint not null default 1 check(revision>0),
  approved_revision bigint,
  approved_hash text check(approved_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  foreign key(organization_id,ad_account_asset_id) references public.meta_assets(organization_id,id) on delete restrict,
  foreign key(organization_id,page_asset_id) references public.meta_assets(organization_id,id) on delete restrict,
  foreign key(organization_id,instagram_asset_id) references public.meta_assets(organization_id,id) on delete restrict,
  check(ends_at is null or starts_at is null or ends_at>starts_at),
  check(status not in ('approved','submitted') or (approved_revision=revision and approved_hash is not null))
);
create index if not exists meta_campaign_drafts_org_updated_idx on public.meta_campaign_drafts(organization_id,updated_at desc);
create index if not exists meta_campaign_drafts_actor_idx on public.meta_campaign_drafts(created_by);
create index if not exists meta_campaign_drafts_account_idx on public.meta_campaign_drafts(organization_id,ad_account_asset_id);
create index if not exists meta_campaign_drafts_page_idx on public.meta_campaign_drafts(organization_id,page_asset_id) where page_asset_id is not null;
create index if not exists meta_campaign_drafts_instagram_idx on public.meta_campaign_drafts(organization_id,instagram_asset_id) where instagram_asset_id is not null;

create table if not exists public.meta_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  connection_id uuid not null,
  asset_id uuid not null,
  grant_id uuid not null,
  campaign_draft_id uuid,
  authorization_version bigint not null check(authorization_version>0),
  kind text not null check(kind in ('instagram_publish','facebook_publish','ads_create','ads_activate','ads_pause','ads_budget_update')),
  operation_key text not null check(length(operation_key) between 1 and 200),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  request_payload jsonb not null check(jsonb_typeof(request_payload)='object'),
  status text not null default 'queued' check(status in ('queued','executing','awaiting_provider','succeeded','failed','uncertain','blocked','cancelled')),
  stage text not null default 'reserved',
  external_ids jsonb not null default '{}' check(jsonb_typeof(external_ids)='object'),
  receipt jsonb check(receipt is null or jsonb_typeof(receipt)='object'),
  error_code text,
  error_message text,
  lease_owner text,
  lease_until timestamptz,
  fence bigint not null default 0 check(fence>=0),
  external_dispatch_started_at timestamptz,
  retry_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,id),
  unique(organization_id,kind,operation_key),
  foreign key(organization_id,connection_id) references public.meta_connections(organization_id,id) on delete restrict,
  foreign key(organization_id,asset_id) references public.meta_assets(organization_id,id) on delete restrict,
  foreign key(organization_id,grant_id,connection_id,asset_id) references public.meta_asset_grants(organization_id,id,connection_id,asset_id) on delete restrict,
  foreign key(organization_id,campaign_draft_id) references public.meta_campaign_drafts(organization_id,id) on delete restrict
);
create index if not exists meta_operations_due_idx on public.meta_operations(retry_at,created_at)
  where status in ('queued','awaiting_provider');
create index if not exists meta_operations_lease_idx on public.meta_operations(lease_until) where status='executing';
create index if not exists meta_operations_org_created_idx on public.meta_operations(organization_id,created_at desc);
create index if not exists meta_operations_actor_idx on public.meta_operations(actor_id);
create index if not exists meta_operations_connection_idx on public.meta_operations(organization_id,connection_id);
create index if not exists meta_operations_asset_idx on public.meta_operations(organization_id,asset_id);
create index if not exists meta_operations_grant_idx on public.meta_operations(organization_id,grant_id,connection_id,asset_id);
create index if not exists meta_operations_draft_idx on public.meta_operations(organization_id,campaign_draft_id) where campaign_draft_id is not null;

create or replace function public.fn_meta_draft_revision()
returns trigger language plpgsql set search_path='' as $$
begin
  if row(new.id,new.organization_id,new.created_by,new.created_at)
    is distinct from row(old.id,old.organization_id,old.created_by,old.created_at) then
    raise exception 'meta_draft_identity_immutable' using errcode='23514'; end if;
  if row(new.ad_account_asset_id,new.page_asset_id,new.instagram_asset_id,new.name,new.objective,
      new.destination_url,new.daily_budget_cents,new.currency,new.starts_at,new.ends_at,new.targeting,new.creative)
    is distinct from row(old.ad_account_asset_id,old.page_asset_id,old.instagram_asset_id,old.name,old.objective,
      old.destination_url,old.daily_budget_cents,old.currency,old.starts_at,old.ends_at,old.targeting,old.creative) then
    new.revision:=old.revision+1;
    new.approved_revision:=null;
    new.approved_hash:=null;
    new.status:='draft';
  else new.revision:=old.revision; end if;
  return new;
end $$;
revoke all on function public.fn_meta_draft_revision() from public,anon,authenticated;
drop trigger if exists trg_meta_draft_revision on public.meta_campaign_drafts;
create trigger trg_meta_draft_revision before update on public.meta_campaign_drafts
  for each row execute function public.fn_meta_draft_revision();

-- Source immutable intent remains in the operation; receipts survive TTLs and
-- disconnection. The app never receives direct grants on secret-bearing rows.
do $meta_acl$
declare tbl text;
begin
  foreach tbl in array array['meta_oauth_attempts','meta_connections','meta_assets','meta_asset_grants','meta_operations','meta_campaign_drafts'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',tbl);
    execute format('grant select,insert,update,delete on public.%I to service_role',tbl);
    execute format('drop policy if exists tenant_isolation_%s_all on public.%I',tbl,tbl);
    execute format('create policy tenant_isolation_%s_all on public.%I for select to authenticated using (organization_id in (select public.fn_user_org_ids()))',tbl,tbl);
    execute format('drop trigger if exists trg_meta_updated_at on public.%I',tbl);
    execute format('create trigger trg_meta_updated_at before update on public.%I for each row execute function public.fn_set_updated_at()',tbl);
  end loop;
end $meta_acl$;
-- Security is ACL + RLS; even a legitimate organization member cannot fetch
-- ciphertext. Above policies are defense-in-depth if a grant is reintroduced.

create or replace function public.fn_meta_immutable_identity()
returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='meta_connections' then
    if new.version<old.version then
      raise exception 'meta_authorization_version_regression' using errcode='23514';
    end if;
    if
    (to_jsonb(new)-array['actor_name','oauth_access_token_encrypted','token_type','token_expires_at','data_access_expires_at','scopes','granular_scopes','version','status','last_validated_at','revoked_at','updated_at'])
    is distinct from
    (to_jsonb(old)-array['actor_name','oauth_access_token_encrypted','token_type','token_expires_at','data_access_expires_at','scopes','granular_scopes','version','status','last_validated_at','revoked_at','updated_at']) then
    raise exception 'meta_connection_identity_immutable' using errcode='23514';
    end if;
  elsif tg_table_name='meta_operations' then
    if
    row(new.id,new.organization_id,new.actor_id,new.connection_id,new.asset_id,new.grant_id,new.campaign_draft_id,new.authorization_version,new.kind,new.operation_key,new.request_hash,new.request_payload,new.created_at)
      is distinct from row(old.id,old.organization_id,old.actor_id,old.connection_id,old.asset_id,old.grant_id,old.campaign_draft_id,old.authorization_version,old.kind,old.operation_key,old.request_hash,old.request_payload,old.created_at) then
    raise exception 'meta_operation_intent_immutable' using errcode='23514';
    end if;
  elsif tg_table_name='meta_oauth_attempts' then
    if
    row(new.id,new.organization_id,new.actor_id,new.auth_session_id,new.app_id,new.config_id,new.config_revision,new.state_hash,new.cookie_hash,new.created_at)
      is distinct from row(old.id,old.organization_id,old.actor_id,old.auth_session_id,old.app_id,old.config_id,old.config_revision,old.state_hash,old.cookie_hash,old.created_at) then
    raise exception 'meta_oauth_binding_immutable' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.fn_meta_immutable_identity() from public,anon,authenticated;
drop trigger if exists trg_meta_connection_identity on public.meta_connections;
create trigger trg_meta_connection_identity before update on public.meta_connections
  for each row execute function public.fn_meta_immutable_identity();
drop trigger if exists trg_meta_operation_intent on public.meta_operations;
create trigger trg_meta_operation_intent before update on public.meta_operations
  for each row execute function public.fn_meta_immutable_identity();
drop trigger if exists trg_meta_oauth_binding on public.meta_oauth_attempts;
create trigger trg_meta_oauth_binding before update on public.meta_oauth_attempts
  for each row execute function public.fn_meta_immutable_identity();

create or replace function public.fn_meta_require_actor(p_organization_id uuid,p_actor_id uuid,p_min_role text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.user_organizations m
    where m.organization_id=p_organization_id and m.user_id=p_actor_id
      and m.accepted_at is not null and m.revoked_at is null
      and (m.role='admin' or (p_min_role='manager' and m.role='manager')) for share;
  if not found then raise exception 'meta_actor_forbidden' using errcode='42501'; end if;
end $$;
revoke all on function public.fn_meta_require_actor(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_meta_require_actor(uuid,uuid,text) to service_role;

create or replace function public.fn_meta_oauth_claim(p_state_hash text,p_cookie_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare attempt public.meta_oauth_attempts;
begin
  update public.meta_oauth_attempts a
    set status='exchanging',callback_claim_id=gen_random_uuid(),callback_claimed_at=now()
    where a.state_hash=p_state_hash and a.cookie_hash=p_cookie_hash and a.status='pending'
      and a.expires_at>now() and exists(select 1 from public.platform_meta_app p where p.id=1
        and p.native_enabled and p.app_id=a.app_id and p.config_id=a.config_id and p.config_revision=a.config_revision)
    returning a.* into attempt;
  if not found then return null; end if;
  return to_jsonb(attempt)-'pending_result_encrypted';
end $$;
revoke all on function public.fn_meta_oauth_claim(text,text) from public,anon,authenticated;
grant execute on function public.fn_meta_oauth_claim(text,text) to service_role;

create or replace function public.fn_meta_oauth_store_result(
  p_attempt_id uuid,p_callback_claim_id uuid,p_ticket_hash text,p_result_encrypted bytea
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_ticket_hash !~ '^[0-9a-f]{64}$' or p_result_encrypted is null then return false; end if;
  update public.meta_oauth_attempts a set status='ready',ticket_hash=p_ticket_hash,pending_result_encrypted=p_result_encrypted
    where a.id=p_attempt_id and a.callback_claim_id=p_callback_claim_id and a.status='exchanging'
      and a.expires_at>now();
  return found;
end $$;
revoke all on function public.fn_meta_oauth_store_result(uuid,uuid,text,bytea) from public,anon,authenticated;
grant execute on function public.fn_meta_oauth_store_result(uuid,uuid,text,bytea) to service_role;

create or replace function public.fn_meta_inventory_apply(
  p_organization_id uuid,p_connection_id uuid,p_assets jsonb,p_preserve_selected boolean
) returns void language plpgsql security invoker set search_path='' as $$
declare entry jsonb; v_asset_id uuid; parent_id uuid;
begin
  if jsonb_typeof(p_assets) is distinct from 'array' or jsonb_array_length(p_assets)>1000 then
    raise exception 'meta_oauth_asset_invalid' using errcode='PT400'; end if;
  update public.meta_asset_grants g set selected=false,status='revoked',page_access_token_encrypted=null
    where g.organization_id=p_organization_id and g.connection_id=p_connection_id
      and (not p_preserve_selected or not exists(select 1 from jsonb_array_elements(p_assets) e
        join public.meta_assets a on a.organization_id=p_organization_id and a.id=g.asset_id
        where e->>'kind'=a.kind and e->>'external_id'=a.external_id));
  for entry in select v from jsonb_array_elements(p_assets) v
    order by case when v->>'kind'='page' then 0 else 1 end loop
    if entry->>'kind' is null or entry->>'kind' not in ('page','instagram','ad_account')
      or nullif(entry->>'external_id','') is null
      or jsonb_typeof(coalesce(entry->'metadata','{}'))<>'object'
      or jsonb_typeof(coalesce(entry->'tasks','[]'))<>'array'
      or jsonb_typeof(coalesce(entry->'permissions','[]'))<>'array' then
      raise exception 'meta_oauth_asset_invalid' using errcode='PT400'; end if;
    parent_id:=null;
    if nullif(entry->>'parent_page_external_id','') is not null then
      if not exists(select 1 from jsonb_array_elements(p_assets) e
        where e->>'kind'='page' and e->>'external_id'=entry->>'parent_page_external_id') then
        raise exception 'meta_oauth_page_binding_invalid' using errcode='PT400'; end if;
      select a.id into parent_id from public.meta_assets a where a.organization_id=p_organization_id
        and a.kind='page' and a.external_id=entry->>'parent_page_external_id';
      if not found then raise exception 'meta_oauth_page_binding_invalid' using errcode='PT400'; end if;
    end if;
    insert into public.meta_assets(organization_id,kind,external_id,name,parent_page_id,currency,timezone,metadata)
      values(p_organization_id,entry->>'kind',entry->>'external_id',coalesce(entry->>'name',''),parent_id,
        nullif(entry->>'currency',''),nullif(entry->>'timezone',''),coalesce(entry->'metadata','{}'))
      on conflict(organization_id,kind,external_id) do update set name=excluded.name,parent_page_id=excluded.parent_page_id,
        currency=excluded.currency,timezone=excluded.timezone,metadata=excluded.metadata
      returning id into v_asset_id;
    insert into public.meta_asset_grants(organization_id,connection_id,asset_id,tasks,permissions,page_access_token_encrypted)
      values(p_organization_id,p_connection_id,v_asset_id,
        array(select jsonb_array_elements_text(coalesce(entry->'tasks','[]'))),
        array(select jsonb_array_elements_text(coalesce(entry->'permissions','[]'))),
        case when nullif(entry->>'page_access_token','') is not null then public.fn_encrypt_oauth(entry->>'page_access_token') else null end)
      on conflict(organization_id,connection_id,asset_id) do update set tasks=excluded.tasks,permissions=excluded.permissions,
        page_access_token_encrypted=excluded.page_access_token_encrypted,
        selected=case when p_preserve_selected then meta_asset_grants.selected else false end,
        status='healthy',observed_at=now();
  end loop;
end $$;
revoke all on function public.fn_meta_inventory_apply(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.fn_meta_inventory_apply(uuid,uuid,jsonb,boolean) to service_role;

create or replace function public.fn_meta_refresh_inventory(
  p_organization_id uuid,p_connection_id uuid,p_expected_version bigint,p_assets jsonb,
  p_scopes text[],p_granular_scopes jsonb,p_token_expires_at timestamptz,p_data_access_expires_at timestamptz
) returns boolean language plpgsql security invoker set search_path='' as $$
declare connection public.meta_connections;
begin
  select c.* into connection from public.meta_connections c where c.organization_id=p_organization_id
    and c.id=p_connection_id and c.version=p_expected_version and c.status in ('selection_pending','healthy') for update;
  if not found then return false; end if;
  perform public.fn_meta_inventory_apply(p_organization_id,p_connection_id,p_assets,true);
  update public.meta_connections set scopes=coalesce(p_scopes,'{}'),granular_scopes=coalesce(p_granular_scopes,'[]'),
    token_expires_at=p_token_expires_at,data_access_expires_at=p_data_access_expires_at,last_validated_at=now(),
    status=case when (p_token_expires_at is not null and p_token_expires_at<=now())
      or (p_data_access_expires_at is not null and p_data_access_expires_at<=now()) then 'token_expired'
      when exists(select 1 from public.meta_asset_grants g where g.organization_id=p_organization_id
        and g.connection_id=p_connection_id and g.status='healthy' and g.selected) then 'healthy' else 'selection_pending' end
    where organization_id=p_organization_id and id=p_connection_id and version=p_expected_version;
  return found;
end $$;
revoke all on function public.fn_meta_refresh_inventory(uuid,uuid,bigint,jsonb,text[],jsonb,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meta_refresh_inventory(uuid,uuid,bigint,jsonb,text[],jsonb,timestamptz,timestamptz) to service_role;

create or replace function public.fn_meta_oauth_finalize(
  p_organization_id uuid,p_actor_id uuid,p_auth_session_id text,p_ticket_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  attempt public.meta_oauth_attempts;
  connection public.meta_connections;
  payload jsonb;
  remote_id text;
begin
  perform public.fn_meta_require_actor(p_organization_id,p_actor_id,'admin');
  select a.* into attempt from public.meta_oauth_attempts a
    where a.organization_id=p_organization_id and a.actor_id=p_actor_id
      and a.auth_session_id=p_auth_session_id and a.ticket_hash=p_ticket_hash
      and a.status='ready' and a.expires_at>now() for update;
  if not found or not exists(select 1 from public.platform_meta_app p where p.id=1 and p.native_enabled
    and p.app_id=attempt.app_id and p.config_id=attempt.config_id and p.config_revision=attempt.config_revision) then
    raise exception 'meta_oauth_finalize_invalid' using errcode='PT400';
  end if;
  payload:=public.fn_decrypt_oauth(attempt.pending_result_encrypted)::jsonb;
  if jsonb_typeof(payload)<>'object' or nullif(payload->>'access_token','') is null
    or nullif(payload->>'remote_actor_id','') is null
    or jsonb_typeof(coalesce(payload->'assets','[]'))<>'array'
    or jsonb_typeof(coalesce(payload->'scopes','[]'))<>'array'
    or jsonb_typeof(coalesce(payload->'granular_scopes','[]'))<>'array' then
    raise exception 'meta_oauth_result_invalid' using errcode='PT400';
  end if;
  remote_id:=payload->>'remote_actor_id';
  insert into public.meta_connections(organization_id,app_id,local_actor_id,remote_actor_id,actor_name,
    oauth_access_token_encrypted,token_type,token_expires_at,data_access_expires_at,scopes,granular_scopes,status)
    values(p_organization_id,attempt.app_id,p_actor_id,remote_id,coalesce(payload->>'remote_actor_name',''),
      public.fn_encrypt_oauth(payload->>'access_token'),coalesce(payload->>'token_type','user'),
      nullif(payload->>'token_expires_at','')::timestamptz,nullif(payload->>'data_access_expires_at','')::timestamptz,
      array(select jsonb_array_elements_text(coalesce(payload->'scopes','[]'))),coalesce(payload->'granular_scopes','[]'),'selection_pending')
    on conflict(organization_id,app_id,local_actor_id,remote_actor_id) do update set
      actor_name=excluded.actor_name,oauth_access_token_encrypted=excluded.oauth_access_token_encrypted,
      token_type=excluded.token_type,token_expires_at=excluded.token_expires_at,data_access_expires_at=excluded.data_access_expires_at,
      scopes=excluded.scopes,granular_scopes=excluded.granular_scopes,version=meta_connections.version+1,
      status='selection_pending',revoked_at=null,last_validated_at=now()
    returning * into connection;
  perform public.fn_meta_inventory_apply(p_organization_id,connection.id,coalesce(payload->'assets','[]'),false);
  update public.meta_operations set status=case when external_dispatch_started_at is null then 'blocked' else 'uncertain' end,
    error_code='meta_authorization_changed',lease_owner=null,lease_until=null,fence=fence+1
    where organization_id=p_organization_id and connection_id=connection.id and status in ('queued','executing','awaiting_provider');
  update public.meta_oauth_attempts set status='finalized',finalized_at=now(),pending_result_encrypted=null
    where organization_id=p_organization_id and id=attempt.id;
  return jsonb_build_object('connection_id',connection.id,'version',connection.version,'status',connection.status);
end $$;
revoke all on function public.fn_meta_oauth_finalize(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_meta_oauth_finalize(uuid,uuid,text,text) to service_role;

create or replace function public.fn_meta_select_assets(
  p_organization_id uuid,p_actor_id uuid,p_connection_id uuid,p_asset_ids uuid[]
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare connection public.meta_connections; selected_count int;
begin
  perform public.fn_meta_require_actor(p_organization_id,p_actor_id,'admin');
  select * into connection from public.meta_connections c where c.organization_id=p_organization_id and c.id=p_connection_id for update;
  if not found or connection.status not in ('selection_pending','healthy') or connection.oauth_access_token_encrypted is null
    or (connection.token_expires_at is not null and connection.token_expires_at<=now())
    or (connection.data_access_expires_at is not null and connection.data_access_expires_at<=now()) then
    raise exception 'meta_connection_unavailable' using errcode='PT409'; end if;
  if p_asset_ids is null or cardinality(p_asset_ids)>200 or exists(
    select 1 from unnest(p_asset_ids) chosen where not exists(select 1 from public.meta_asset_grants g
      where g.organization_id=p_organization_id and g.connection_id=p_connection_id and g.asset_id=chosen and g.status='healthy')) then
    raise exception 'meta_asset_not_granted' using errcode='42501'; end if;
  update public.meta_asset_grants set selected=(asset_id=any(p_asset_ids))
    where organization_id=p_organization_id and connection_id=p_connection_id;
  get diagnostics selected_count=row_count;
  select count(*)::int into selected_count from public.meta_asset_grants
    where organization_id=p_organization_id and connection_id=p_connection_id and selected;
  update public.meta_connections set status=case when selected_count>0 then 'healthy' else 'selection_pending' end
    where organization_id=p_organization_id and id=p_connection_id returning * into connection;
  return jsonb_build_object('connection_id',connection.id,'selected_count',selected_count,'status',connection.status);
end $$;
revoke all on function public.fn_meta_select_assets(uuid,uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.fn_meta_select_assets(uuid,uuid,uuid,uuid[]) to service_role;

create or replace function public.fn_meta_disconnect(
  p_organization_id uuid,p_actor_id uuid,p_connection_id uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare changed int;
begin
  perform public.fn_meta_require_actor(p_organization_id,p_actor_id,'admin');
  update public.meta_connections set status='disconnected',oauth_access_token_encrypted=null,revoked_at=now(),version=version+1
    where organization_id=p_organization_id and (p_connection_id is null or id=p_connection_id) and status<>'disconnected';
  get diagnostics changed=row_count;
  update public.meta_asset_grants set status='revoked',selected=false,page_access_token_encrypted=null
    where organization_id=p_organization_id and (p_connection_id is null or connection_id=p_connection_id);
  update public.meta_operations set status=case when external_dispatch_started_at is null then 'cancelled' else 'uncertain' end,
    error_code='meta_disconnected',lease_owner=null,lease_until=null,fence=fence+1
    where organization_id=p_organization_id and (p_connection_id is null or connection_id=p_connection_id)
      and status in ('queued','executing','awaiting_provider');
  update public.meta_oauth_attempts set status='failed',failure_code='meta_disconnected',pending_result_encrypted=null
    where organization_id=p_organization_id and actor_id=p_actor_id and status in ('pending','exchanging','ready');
  return jsonb_build_object('disconnected_count',changed);
end $$;
revoke all on function public.fn_meta_disconnect(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.fn_meta_disconnect(uuid,uuid,uuid) to service_role;

-- Routine maintenance purges temporary encrypted results, never operation
-- idempotency or external receipts. A bounded batch avoids long transactions.
create or replace function public.fn_meta_expire_oauth(p_limit int default 200)
returns integer language plpgsql security invoker set search_path='' as $$
declare changed int;
begin
  with expired as (select id from public.meta_oauth_attempts where expires_at<=now()
    and (status in ('pending','exchanging','ready') or pending_result_encrypted is not null)
    order by expires_at limit greatest(1,least(p_limit,1000)) for update skip locked)
  update public.meta_oauth_attempts a set status='expired',pending_result_encrypted=null,ticket_hash=null
    from expired e where a.id=e.id;
  get diagnostics changed=row_count;
  return changed;
end $$;
revoke all on function public.fn_meta_expire_oauth(integer) from public,anon,authenticated;
grant execute on function public.fn_meta_expire_oauth(integer) to service_role;

create or replace function public.fn_meta_scope_granted(
  p_scopes text[],p_permissions text[],p_granular_scopes jsonb,p_scope text,p_external_id text,p_parent_external_id text default null
) returns boolean language sql stable security invoker set search_path='' as $$
  select coalesce(p_scopes @> array[p_scope] and p_permissions @> array[p_scope]
    and (not exists(select 1 from jsonb_array_elements(p_granular_scopes) scope where scope->>'scope'=p_scope)
      or exists(select 1 from jsonb_array_elements(p_granular_scopes) scope
        where scope->>'scope'=p_scope and (not (scope ? 'target_ids')
          or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(scope->'target_ids')='array'
            then scope->'target_ids' else '[]'::jsonb end) target
            where regexp_replace(target,'^act_','')=regexp_replace(p_external_id,'^act_','') or target=p_parent_external_id)))),false)
$$;
revoke all on function public.fn_meta_scope_granted(text[],text[],jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_meta_scope_granted(text[],text[],jsonb,text,text,text) to service_role;

create or replace function public.fn_meta_operation_authorized(p_operation_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.meta_operations o
    join public.meta_connections c on c.organization_id=o.organization_id and c.id=o.connection_id
    join public.meta_asset_grants g on g.organization_id=o.organization_id and g.id=o.grant_id
      and g.connection_id=o.connection_id and g.asset_id=o.asset_id
    join public.meta_assets a on a.organization_id=o.organization_id and a.id=o.asset_id
    left join public.meta_assets parent on parent.organization_id=o.organization_id and parent.id=a.parent_page_id and parent.kind='page'
    join public.platform_meta_app p on p.id=1 and p.app_id=c.app_id
    join public.user_organizations m on m.organization_id=o.organization_id and m.user_id=o.actor_id
    where o.id=p_operation_id and c.status='healthy' and c.oauth_access_token_encrypted is not null
      and c.version=o.authorization_version and g.status='healthy' and g.selected
      and (c.token_expires_at is null or c.token_expires_at>now())
      and (c.data_access_expires_at is null or c.data_access_expires_at>now())
      and m.accepted_at is not null and m.revoked_at is null and m.role in ('manager','admin') and p.native_enabled
      and ((o.kind='instagram_publish' and a.kind='instagram' and p.instagram_enabled and parent.id is not null
          and g.tasks && array['CREATE_CONTENT','MANAGE','PROFILE_PLUS_CREATE_CONTENT']
          and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'instagram_content_publish',a.external_id,parent.external_id)
          and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'instagram_basic',a.external_id,parent.external_id)
          and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'pages_read_engagement',a.external_id,parent.external_id))
        or (o.kind='facebook_publish' and a.kind='page' and p.instagram_enabled
          and g.tasks && array['CREATE_CONTENT','MANAGE','PROFILE_PLUS_CREATE_CONTENT']
          and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'pages_manage_posts',a.external_id,null))
        or (o.kind in ('ads_create','ads_activate','ads_pause','ads_budget_update') and a.kind='ad_account' and p.ads_enabled
          and g.tasks && array['ADVERTISE','MANAGE','ADMIN'] and a.metadata->>'account_status'='1'
          and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'ads_management',a.external_id,null)
          and (o.kind<>'ads_create' or exists(select 1 from public.meta_campaign_drafts d
            where d.organization_id=o.organization_id and d.id=o.campaign_draft_id and d.ad_account_asset_id=o.asset_id
              and d.status in ('approved','submitted') and d.revision::text=o.request_payload->>'draft_revision'
              and d.approved_hash=o.request_payload->>'approved_hash')))))
$$;
revoke all on function public.fn_meta_operation_authorized(uuid) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_authorized(uuid) to service_role;

create or replace function public.fn_meta_operation_reserve(
  p_organization_id uuid,p_actor_id uuid,p_connection_id uuid,p_asset_id uuid,p_grant_id uuid,
  p_authorization_version bigint,p_kind text,p_operation_key text,p_request_hash text,p_request_payload jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare operation public.meta_operations; replay boolean:=false; publication_id uuid;
begin
  perform public.fn_meta_require_actor(p_organization_id,p_actor_id,'manager');
  insert into public.meta_operations(organization_id,actor_id,connection_id,asset_id,grant_id,authorization_version,
    kind,operation_key,request_hash,request_payload,campaign_draft_id)
    values(p_organization_id,p_actor_id,p_connection_id,p_asset_id,p_grant_id,p_authorization_version,
      p_kind,p_operation_key,p_request_hash,p_request_payload,nullif(p_request_payload->>'campaign_draft_id','')::uuid)
    on conflict(organization_id,kind,operation_key) do nothing returning * into operation;
  if not found then
    select * into operation from public.meta_operations o where o.organization_id=p_organization_id
      and o.kind=p_kind and o.operation_key=p_operation_key for share;
    if operation.request_hash is distinct from p_request_hash or operation.request_payload is distinct from p_request_payload
      or operation.actor_id is distinct from p_actor_id or operation.connection_id is distinct from p_connection_id
      or operation.asset_id is distinct from p_asset_id or operation.grant_id is distinct from p_grant_id then
      raise exception 'meta_idempotency_conflict' using errcode='PT409'; end if;
    replay:=true;
  else
    if not public.fn_meta_operation_authorized(operation.id) then
      raise exception 'meta_operation_not_authorized' using errcode='42501'; end if;
    if p_kind='instagram_publish' then
      if coalesce(p_request_payload->>'publication_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'meta_publication_invalid' using errcode='22023'; end if;
      publication_id:=(p_request_payload->>'publication_id')::uuid;
      update public.instagram_publications publication set operation_id=operation.id,status='sending',updated_at=now()
        from public.meta_assets asset
        where publication.id=publication_id and publication.organization_id=p_organization_id
          and publication.requested_by=p_actor_id and publication.provider='meta'
          and publication.meta_asset_id=p_asset_id and publication.status='preparing'
          and publication.operation_id is null and asset.organization_id=p_organization_id
          and asset.id=p_asset_id and publication.account_id=asset.external_id;
      if not found then
        raise exception 'meta_publication_not_prepared' using errcode='42501'; end if;
    end if;
    -- Wake-up and durable intent commit together; the event carries only a
    -- pointer. Dispatcher deduplication cannot authorize an extra Graph write.
    insert into public.event_log(organization_id,event_type,entity_kind,entity_id,payload)
      values(p_organization_id,'meta.operation_requested','meta_operation',operation.id,jsonb_build_object('operation_id',operation.id));
  end if;
  return jsonb_build_object('operation',to_jsonb(operation),'replay',replay);
end $$;
revoke all on function public.fn_meta_operation_reserve(uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_reserve(uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb) to service_role;

create or replace function public.fn_meta_operation_claim(
  p_operation_id uuid,p_worker_id text,p_lease_seconds integer default 90
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare operation public.meta_operations;
begin
  if nullif(p_worker_id,'') is null or length(p_worker_id)>200 or p_lease_seconds not between 5 and 300 then
    raise exception 'meta_lease_invalid' using errcode='22023'; end if;
  select * into operation from public.meta_operations o where o.id=p_operation_id
    and ((o.status in ('queued','awaiting_provider') and o.retry_at<=now())
      or (o.status='executing' and o.lease_until<=now())) for update skip locked;
  if not found then return null; end if;
  if operation.external_dispatch_started_at is not null and operation.status='executing' then
    update public.meta_operations set status='uncertain',error_code='meta_dispatch_interrupted',
      lease_owner=null,lease_until=null,fence=fence+1 where id=operation.id and organization_id=operation.organization_id;
    return null;
  end if;
  if not public.fn_meta_operation_authorized(operation.id) then
    update public.meta_operations set status='blocked',error_code='meta_authorization_changed',
      lease_owner=null,lease_until=null,fence=fence+1 where id=operation.id and organization_id=operation.organization_id;
    return null;
  end if;
  update public.meta_operations o set status='executing',lease_owner=p_worker_id,
    lease_until=now()+make_interval(secs=>p_lease_seconds),fence=o.fence+1
    where o.id=operation.id and o.organization_id=operation.organization_id
      and ((o.status in ('queued','awaiting_provider') and o.retry_at<=now())
        or (o.status='executing' and o.lease_until<=now() and o.external_dispatch_started_at is null))
    returning o.* into operation;
  if not found then return null; end if;
  return to_jsonb(operation);
end $$;
revoke all on function public.fn_meta_operation_claim(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_claim(uuid,text,integer) to service_role;

create or replace function public.fn_meta_operation_begin_dispatch(
  p_organization_id uuid,p_operation_id uuid,p_worker_id text,p_fence bigint
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.meta_operations o set external_dispatch_started_at=clock_timestamp()
    where o.organization_id=p_organization_id and o.id=p_operation_id and o.status='executing'
      and o.lease_owner=p_worker_id and o.fence=p_fence and o.lease_until>now()
      and o.external_dispatch_started_at is null and public.fn_meta_operation_authorized(o.id);
  return found;
end $$;
revoke all on function public.fn_meta_operation_begin_dispatch(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_begin_dispatch(uuid,uuid,text,bigint) to service_role;

create or replace function public.fn_meta_operation_heartbeat(
  p_organization_id uuid,p_operation_id uuid,p_worker_id text,p_fence bigint,p_lease_seconds integer default 90
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if p_lease_seconds not between 5 and 300 then return false; end if;
  update public.meta_operations o set lease_until=now()+make_interval(secs=>p_lease_seconds)
    where o.organization_id=p_organization_id and o.id=p_operation_id and o.status='executing'
      and o.lease_owner=p_worker_id and o.fence=p_fence and o.lease_until>now();
  return found;
end $$;
revoke all on function public.fn_meta_operation_heartbeat(uuid,uuid,text,bigint,integer) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_heartbeat(uuid,uuid,text,bigint,integer) to service_role;

create or replace function public.fn_meta_operation_checkpoint(
  p_organization_id uuid,p_operation_id uuid,p_worker_id text,p_fence bigint,p_status text,p_stage text,
  p_external_ids jsonb,p_receipt jsonb,p_error_code text,p_error_message text,p_retry_at timestamptz
) returns boolean language plpgsql security invoker set search_path='' as $$
declare operation public.meta_operations;
begin
  if p_status not in ('executing','awaiting_provider','succeeded','failed','uncertain','blocked','cancelled')
    or jsonb_typeof(coalesce(p_external_ids,'{}'))<>'object'
    or (p_receipt is not null and jsonb_typeof(p_receipt)<>'object') then
    raise exception 'meta_checkpoint_invalid' using errcode='22023'; end if;
  update public.meta_operations o set status=p_status,stage=coalesce(p_stage,o.stage),
    external_ids=o.external_ids||coalesce(p_external_ids,'{}'),receipt=coalesce(p_receipt,o.receipt),
    error_code=p_error_code,error_message=p_error_message,retry_at=coalesce(p_retry_at,o.retry_at),
    external_dispatch_started_at=case when p_status in ('executing','awaiting_provider','succeeded') then null else o.external_dispatch_started_at end,
    lease_owner=case when p_status='executing' then o.lease_owner else null end,
    lease_until=case when p_status='executing' then o.lease_until else null end,
    completed_at=case when p_status in ('succeeded','failed','cancelled') then now() else null end
    where o.organization_id=p_organization_id and o.id=p_operation_id and o.status='executing'
      and o.lease_owner=p_worker_id and o.fence=p_fence and o.lease_until>now()
    returning o.* into operation;
  if not found then return false; end if;
  update public.instagram_publications set status=case operation.status
      when 'succeeded' then 'published' when 'failed' then 'failed'
      when 'uncertain' then 'uncertain' when 'awaiting_provider' then 'pending'
      when 'blocked' then 'failed' when 'cancelled' then 'failed' else 'sending' end,
    provider_post_id=coalesce(operation.receipt->>'provider_post_id',operation.receipt->>'media_id',provider_post_id),
    permalink=coalesce(operation.receipt->>'permalink',permalink),error=operation.error_message
    where organization_id=p_organization_id and operation_id=p_operation_id and provider='meta';
  return true;
end $$;
revoke all on function public.fn_meta_operation_checkpoint(uuid,uuid,text,bigint,text,text,jsonb,jsonb,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_checkpoint(uuid,uuid,text,bigint,text,text,jsonb,jsonb,text,text,timestamptz) to service_role;

-- The legacy provider remains authoritative for every existing publication.
alter table public.instagram_publications
  add column if not exists provider text not null default 'zernio',
  add column if not exists meta_asset_id uuid,
  add column if not exists requested_by uuid references auth.users(id) on delete restrict,
  add column if not exists operation_id uuid;
create unique index if not exists instagram_publications_org_id_uk on public.instagram_publications(organization_id,id);
create unique index if not exists instagram_publications_operation_uk on public.instagram_publications(organization_id,operation_id) where operation_id is not null;
create index if not exists instagram_publications_meta_asset_idx on public.instagram_publications(organization_id,meta_asset_id) where meta_asset_id is not null;
create index if not exists instagram_publications_requested_by_idx on public.instagram_publications(requested_by) where requested_by is not null;
-- The bounded global cleanup must not scan the unrelated legacy history.
create index if not exists instagram_publications_meta_unreserved_idx on public.instagram_publications(created_at)
  where provider='meta' and status='preparing' and operation_id is null;
do $meta_publication_constraints$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.instagram_publications'::regclass and conname='instagram_publications_meta_asset_fk') then
    alter table public.instagram_publications add constraint instagram_publications_meta_asset_fk
      foreign key(organization_id,meta_asset_id) references public.meta_assets(organization_id,id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.instagram_publications'::regclass and conname='instagram_publications_meta_operation_fk') then
    alter table public.instagram_publications add constraint instagram_publications_meta_operation_fk
      foreign key(organization_id,operation_id) references public.meta_operations(organization_id,id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.instagram_publications'::regclass and conname='instagram_publications_provider_target_check') then
    alter table public.instagram_publications add constraint instagram_publications_provider_target_check
      check((provider='zernio' and meta_asset_id is null and operation_id is null)
        or (provider='meta' and meta_asset_id is not null));
  end if;
end $meta_publication_constraints$;

comment on table public.meta_operations is 'Durable external intent: reservation and event commit together; uncertain writes never auto-retry, fencing guards every worker update. No TTL releases an executed operation key.';
comment on table public.meta_connections is 'One OAuth authorization per organization, issuing App and local/remote actor. Canonical encrypted token owner; no credential duplication into legacy social/ads connections.';
comment on table public.meta_assets is 'Tenant-scoped remote inventory. Metadata is an allowlisted application DTO, never a raw Graph response or credentials. Selection and authorization belong to grants.';
comment on column public.platform_meta_app.native_enabled is 'Opt-in native social/Ads login. Defaults off; existing WhatsApp App Secret and verification behavior stay available.';
notify pgrst,'reload schema';
