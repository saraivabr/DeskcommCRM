-- 0417 Meta privacy: provider-authenticated subjects revoke immediately; a
-- leased, bounded cleanup erases only their native derivatives and copied media.
-- CRM, Auth, Studio originals, Zernio and remote posts/Ads are never deleted.

do $meta_privacy_known_core$
declare target record; source text; marker text;
begin
  if to_regclass('storage.objects') is null then raise exception 'meta_privacy_storage_missing' using errcode='55000'; end if;
  for target in select * from (values
    ('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)','af56fbc10a73e4c28395994ff694641c'),
    ('public.fn_meta_oauth_finalize(uuid,uuid,text,text)','166333c3e3c189becdb3bb0e86106fd3'),
    ('public.fn_meta_operation_authorized(uuid)','1b050b0ffcae618822107679dcfefa38')
  ) approved(signature,source_hash) loop
    select p.prosrc,obj_description(p.oid,'pg_proc') into source,marker from pg_proc p where p.oid=to_regprocedure(target.signature);
    if not found then raise exception 'meta_privacy_core_missing' using errcode='55000'; end if;
    if md5(source)<>target.source_hash and coalesce(marker,'') not like 'meta-privacy-0417-%' then
      raise exception 'meta_privacy_core_unknown' using errcode='55000'; end if;
  end loop;
end $meta_privacy_known_core$;

create table if not exists public.meta_privacy_subjects (
  subject_hash text primary key check(subject_hash ~ '^[0-9a-f]{64}$'),
  app_id text not null check(app_id ~ '^[0-9]{3,100}$'),
  cutoff_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meta_privacy_subjects_app_status_idx on public.meta_privacy_subjects(app_id,status);

create table if not exists public.meta_privacy_requests (
  id uuid primary key default gen_random_uuid(),
  subject_hash text not null references public.meta_privacy_subjects(subject_hash) on delete restrict,
  app_id text not null check(app_id ~ '^[0-9]{3,100}$'),
  kind text not null check(kind in ('deauthorization','data_deletion')),
  request_digest text not null check(request_digest ~ '^[0-9a-f]{64}$'),
  confirmation_code_hash text not null unique check(confirmation_code_hash ~ '^[0-9a-f]{64}$'),
  confirmation_code_encrypted bytea not null,
  issued_at timestamptz not null,
  status text not null default 'pending' check(status in ('pending','processing','completed')),
  lease_owner text check(lease_owner is null or length(lease_owner) between 1 and 200),
  lease_until timestamptz,
  fence bigint not null default 0 check(fence>=0),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  retry_at timestamptz not null default now(),
  unique(app_id,kind,request_digest),
  check((status='completed')=(completed_at is not null)),
  check((lease_owner is null)=(lease_until is null))
);
create index if not exists meta_privacy_requests_subject_idx on public.meta_privacy_requests(subject_hash,status);
create index if not exists meta_privacy_requests_due_idx on public.meta_privacy_requests(retry_at,created_at,id) where status<>'completed';

-- Temporary UUID pointers intentionally outlive their source rows until copied
-- Storage objects are acknowledged. No remote user ID or access token persists.
create table if not exists public.meta_privacy_targets (
  subject_hash text not null references public.meta_privacy_subjects(subject_hash) on delete restrict,
  connection_id uuid not null,
  organization_id uuid not null,
  asset_ids uuid[] not null default '{}',
  primary key(subject_hash,connection_id),
  check(cardinality(asset_ids)<=2000)
);
create table if not exists public.meta_privacy_storage_objects (
  id uuid primary key default gen_random_uuid(),
  subject_hash text not null references public.meta_privacy_subjects(subject_hash) on delete restrict,
  organization_id uuid not null,
  publication_id uuid not null,
  object_index integer not null check(object_index between 0 and 9),
  created_at timestamptz not null default now(),
  unique(subject_hash,organization_id,publication_id,object_index)
);
create index if not exists meta_privacy_storage_objects_due_idx on public.meta_privacy_storage_objects(subject_hash,created_at,id);

-- Publication UUID suppression is retained after erasure: an uploader that
-- ignored a client AbortSignal must not commit a late native copy afterward.
create table if not exists public.meta_privacy_media_tombstones (
  organization_id uuid not null,
  publication_id uuid not null,
  created_at timestamptz not null default now(),
  primary key(organization_id,publication_id)
);

do $meta_privacy_acl$
declare tbl text;
begin
  foreach tbl in array array['meta_privacy_subjects','meta_privacy_requests','meta_privacy_targets','meta_privacy_storage_objects','meta_privacy_media_tombstones'] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',tbl);
    execute format('grant select,insert,update,delete on public.%I to service_role',tbl);
  end loop;
end $meta_privacy_acl$;

-- A stable keyed digest prevents replay/resurrection without retaining the
-- provider user ID. The canonical encryption key is never returned or logged.
create or replace function public.fn_meta_privacy_subject_hash(p_app_id text,p_remote_actor_id text)
returns text language plpgsql stable security definer set search_path='' as $$
declare secret text:=private.fn_oauth_key(); crypto_schema text; result text;
begin
  if p_app_id is null or p_app_id !~ '^[0-9]{3,100}$'
    or p_remote_actor_id is null or length(p_remote_actor_id) not between 1 and 200
    or secret is null or length(secret)<32 then
    raise exception 'meta_privacy_subject_invalid' using errcode='22023'; end if;
  select n.nspname into crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  execute format('select encode(%I.hmac(convert_to($1,''UTF8''),convert_to($2,''UTF8''),''sha256''),''hex'')',crypto_schema)
    into result using 'meta-privacy-subject-v1:'||p_app_id||':'||p_remote_actor_id,secret;
  return result;
end $$;
revoke all on function public.fn_meta_privacy_subject_hash(text,text) from public,anon,authenticated;
grant execute on function public.fn_meta_privacy_subject_hash(text,text) to service_role;

create or replace function public.fn_meta_privacy_storage_fence()
returns trigger language plpgsql security definer set search_path='' as $$
declare candidate record; identity text[]; org uuid; publication uuid;
begin
  -- Check OLD and NEW identities on moves too. Ordered resource locks avoid
  -- deadlocks if a trusted Storage process renames two publication objects.
  for candidate in select path from (select new.name path,new.bucket_id bucket
      union select case when tg_op='UPDATE' then old.name else null end,
                   case when tg_op='UPDATE' then old.bucket_id else null end) paths
    where bucket='whatsapp-media' and path is not null order by path loop
    identity:=regexp_match(candidate.path,'^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/instagram/publications/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/([0-9])\.jpg$','i');
    if identity is not null then
      org:=identity[1]::uuid; publication:=identity[2]::uuid;
      perform pg_advisory_xact_lock_shared(hashtextextended('meta-privacy-publication:'||org::text||':'||publication::text,0));
      if exists(select 1 from public.meta_privacy_media_tombstones t where t.organization_id=org and t.publication_id=publication) then
        raise exception 'meta_publication_erased' using errcode='42501'; end if;
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.fn_meta_privacy_storage_fence() from public,anon,authenticated,service_role;
drop trigger if exists trg_meta_privacy_storage_fence on storage.objects;
create trigger trg_meta_privacy_storage_fence before insert or update on storage.objects
  for each row execute function public.fn_meta_privacy_storage_fence();

-- Explicit ownership also covers preparation before an operation is reserved.
alter table public.instagram_publications add column if not exists meta_connection_id uuid;
alter table public.instagram_publications add column if not exists meta_media_cleanup_uncertain boolean not null default false;
alter table public.meta_campaign_drafts add column if not exists meta_connection_id uuid;
update public.instagram_publications p set meta_connection_id=o.connection_id
  from public.meta_operations o where p.provider='meta' and p.meta_connection_id is null
    and p.organization_id=o.organization_id and p.operation_id=o.id;
update public.meta_campaign_drafts d set meta_connection_id=c.id
  from public.meta_connections c where d.meta_connection_id is null
    and d.organization_id=c.organization_id and d.creative->>'connection_id'=c.id::text;
create index if not exists instagram_publications_meta_connection_idx on public.instagram_publications(organization_id,meta_connection_id) where meta_connection_id is not null;
create index if not exists meta_campaign_drafts_connection_idx on public.meta_campaign_drafts(organization_id,meta_connection_id) where meta_connection_id is not null;
create unique index if not exists meta_campaign_drafts_connection_uk on public.meta_campaign_drafts(organization_id,id,meta_connection_id);
do $meta_privacy_fks$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.instagram_publications'::regclass and conname='instagram_publications_meta_connection_fk') then
    alter table public.instagram_publications add constraint instagram_publications_meta_connection_fk
      foreign key(organization_id,meta_connection_id) references public.meta_connections(organization_id,id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.meta_campaign_drafts'::regclass and conname='meta_campaign_drafts_connection_fk') then
    alter table public.meta_campaign_drafts add constraint meta_campaign_drafts_connection_fk
      foreign key(organization_id,meta_connection_id) references public.meta_connections(organization_id,id) on delete restrict;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.meta_operations'::regclass and conname='meta_operations_draft_connection_fk') then
    alter table public.meta_operations add constraint meta_operations_draft_connection_fk
      foreign key(organization_id,campaign_draft_id,connection_id) references public.meta_campaign_drafts(organization_id,id,meta_connection_id) on delete restrict;
  end if;
end $meta_privacy_fks$;

create or replace function public.fn_meta_privacy_connection_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
declare subject text;
begin
  if new.oauth_access_token_encrypted is not null and new.status in ('healthy','selection_pending') then
    subject:=public.fn_meta_privacy_subject_hash(new.app_id,new.remote_actor_id);
    if not pg_try_advisory_xact_lock(hashtextextended('meta-privacy-subject:'||subject,0)) then
      raise exception 'meta_privacy_authorization_unavailable' using errcode='PT409'; end if;
    if exists(select 1 from public.meta_privacy_subjects s where s.subject_hash=subject and s.status='pending') then
      raise exception 'meta_privacy_pending' using errcode='PT409'; end if;
  end if;
  return new;
end $$;
revoke all on function public.fn_meta_privacy_connection_guard() from public,anon,authenticated,service_role;
drop trigger if exists trg_meta_privacy_connection_guard on public.meta_connections;
create trigger trg_meta_privacy_connection_guard before insert or update on public.meta_connections
  for each row execute function public.fn_meta_privacy_connection_guard();

-- An exchange begun before deletion may return after the receipt completed.
-- Reject its encrypted result before it can repopulate temporary Meta PII.
create or replace function public.fn_meta_privacy_oauth_result_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
declare payload jsonb; subject text;
begin
  if new.status='ready' and new.pending_result_encrypted is not null then
    payload:=public.fn_decrypt_oauth(new.pending_result_encrypted)::jsonb;
    subject:=public.fn_meta_privacy_subject_hash(new.app_id,payload->>'remote_actor_id');
    -- UPDATE can already own the attempt row. A try lock prevents the inverse
    -- row -> identity wait against the callback's identity -> attempt order.
    if not pg_try_advisory_xact_lock(hashtextextended('meta-privacy-subject:'||subject,0)) then
      raise exception 'meta_privacy_authorization_unavailable' using errcode='PT409'; end if;
    if exists(select 1 from public.meta_privacy_subjects s where s.subject_hash=subject
      and (s.status='pending' or new.created_at<=s.cutoff_at)) then
      raise exception 'meta_privacy_authorization_unavailable' using errcode='PT409'; end if;
  end if;
  return new;
end $$;
revoke all on function public.fn_meta_privacy_oauth_result_guard() from public,anon,authenticated,service_role;
drop trigger if exists trg_meta_privacy_oauth_result_guard on public.meta_oauth_attempts;
create trigger trg_meta_privacy_oauth_result_guard before insert or update on public.meta_oauth_attempts
  for each row execute function public.fn_meta_privacy_oauth_result_guard();

create or replace function public.fn_meta_privacy_attribution_guard()
returns trigger language plpgsql security invoker set search_path='' as $$
declare v_connection_id uuid;
begin
  if tg_table_name='meta_campaign_drafts' then
    if coalesce(new.creative->>'connection_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'meta_draft_connection_invalid' using errcode='23514'; end if;
    v_connection_id:=(new.creative->>'connection_id')::uuid;
    if new.meta_connection_id is not null and new.meta_connection_id<>v_connection_id then
      raise exception 'meta_draft_connection_invalid' using errcode='23514'; end if;
    new.meta_connection_id:=v_connection_id;
  elsif new.provider='zernio' then
    if new.meta_connection_id is not null then raise exception 'meta_publication_connection_invalid' using errcode='23514'; end if;
    return new;
  else
    v_connection_id:=new.meta_connection_id;
    if v_connection_id is null then raise exception 'meta_publication_connection_required' using errcode='23514'; end if;
    if (tg_op='INSERT' or (tg_op='UPDATE' and (new.id is distinct from old.id
        or new.organization_id is distinct from old.organization_id or new.meta_connection_id is distinct from old.meta_connection_id)))
      and exists(select 1 from public.meta_privacy_media_tombstones t where t.organization_id=new.organization_id and t.publication_id=new.id) then
      raise exception 'meta_publication_erased' using errcode='42501'; end if;
    if new.operation_id is not null and not exists(select 1 from public.meta_operations o
      where o.organization_id=new.organization_id and o.id=new.operation_id and o.connection_id=v_connection_id and o.asset_id=new.meta_asset_id) then
      raise exception 'meta_publication_connection_invalid' using errcode='23514'; end if;
  end if;
  -- Existing bound rows can receive fenced finalization, but new preparation or
  -- draft ownership changes cannot resurrect an authorization during erasure.
  if tg_op='INSERT' or (tg_op='UPDATE' and new.meta_connection_id is distinct from old.meta_connection_id) then
    if tg_table_name='instagram_publications' then
      if exists(select 1 from public.meta_assets a where a.organization_id=new.organization_id and a.id=new.meta_asset_id)
        and not exists(select 1 from public.meta_asset_grants g
          where g.organization_id=new.organization_id and g.connection_id=v_connection_id and g.asset_id=new.meta_asset_id
            and g.status='healthy' and g.selected) then
        raise exception 'meta_publication_connection_invalid' using errcode='23514'; end if;
    end if;
    if not exists(select 1 from public.meta_connections c where c.organization_id=new.organization_id and c.id=v_connection_id
      and c.status in ('healthy','selection_pending') and c.oauth_access_token_encrypted is not null
      and not exists(select 1 from public.meta_privacy_subjects s
        where s.subject_hash=public.fn_meta_privacy_subject_hash(c.app_id,c.remote_actor_id) and s.status='pending')) then
      raise exception 'meta_privacy_authorization_unavailable' using errcode='PT409'; end if;
  end if;
  return new;
end $$;
revoke all on function public.fn_meta_privacy_attribution_guard() from public,anon,authenticated,service_role;
drop trigger if exists trg_meta_privacy_publication_attribution on public.instagram_publications;
create trigger trg_meta_privacy_publication_attribution before insert or update on public.instagram_publications
  for each row execute function public.fn_meta_privacy_attribution_guard();
drop trigger if exists trg_meta_privacy_draft_attribution on public.meta_campaign_drafts;
create trigger trg_meta_privacy_draft_attribution before insert or update on public.meta_campaign_drafts
  for each row execute function public.fn_meta_privacy_attribution_guard();

create or replace function public.fn_meta_privacy_request(
  p_app_id text,p_remote_actor_id text,p_kind text,p_request_digest text,p_confirmation_code text,p_issued_at timestamptz
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare subject text; receipt public.meta_privacy_requests; c public.meta_connections; crypto_schema text; code_hash text;
begin
  if p_kind is null or p_kind not in ('deauthorization','data_deletion')
    or p_request_digest is null or p_request_digest !~ '^[0-9a-f]{64}$'
    or p_confirmation_code is null or p_confirmation_code !~ '^[0-9a-f]{64}$'
    or p_issued_at is null or p_issued_at>now()+interval '5 minutes' then
    raise exception 'meta_privacy_request_invalid' using errcode='22023'; end if;
  perform pg_advisory_xact_lock_shared(416,1);
  if not exists(select 1 from public.platform_meta_app p where p.id=1 and p.app_id=p_app_id and p.app_secret_encrypted is not null) then
    raise exception 'meta_privacy_app_changed' using errcode='PT409'; end if;
  subject:=public.fn_meta_privacy_subject_hash(p_app_id,p_remote_actor_id);
  perform pg_advisory_xact_lock(hashtextextended('meta-privacy-subject:'||subject,0));
  select * into receipt from public.meta_privacy_requests r where r.app_id=p_app_id and r.kind=p_kind and r.request_digest=p_request_digest;
  if found then
    if receipt.subject_hash<>subject then raise exception 'meta_privacy_request_conflict' using errcode='PT409'; end if;
    return jsonb_build_object('request_id',receipt.id,'confirmation_code_encrypted',receipt.confirmation_code_encrypted,'status',receipt.status);
  end if;
  select n.nspname into crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
  execute format('select encode(%I.digest($1,''sha256''),''hex'')',crypto_schema) into code_hash using p_confirmation_code;
  insert into public.meta_privacy_subjects(subject_hash,app_id,cutoff_at,status)
    values(subject,p_app_id,clock_timestamp(),'pending') on conflict(subject_hash) do update set
      cutoff_at=excluded.cutoff_at,status='pending',updated_at=now();
  insert into public.meta_privacy_requests(subject_hash,app_id,kind,request_digest,confirmation_code_hash,confirmation_code_encrypted,issued_at)
    values(subject,p_app_id,p_kind,p_request_digest,code_hash,public.fn_encrypt_oauth(p_confirmation_code),p_issued_at)
    returning * into receipt;
  delete from public.meta_oauth_attempts a where a.app_id=p_app_id and a.status='ready'
    and public.fn_decrypt_oauth(a.pending_result_encrypted)::jsonb->>'remote_actor_id'=p_remote_actor_id;
  for c in select * from public.meta_connections x where x.app_id=p_app_id and x.remote_actor_id=p_remote_actor_id order by x.id for update loop
    insert into public.meta_privacy_targets(subject_hash,connection_id,organization_id,asset_ids)
      select subject,c.id,c.organization_id,coalesce(array_agg(distinct inventory.id) filter(where inventory.id is not null),'{}'::uuid[])
      from (select a.id from public.meta_asset_grants g join public.meta_assets a on a.organization_id=g.organization_id and a.id=g.asset_id
        where g.organization_id=c.organization_id and g.connection_id=c.id
        union select a.parent_page_id from public.meta_asset_grants g join public.meta_assets a on a.organization_id=g.organization_id and a.id=g.asset_id
        where g.organization_id=c.organization_id and g.connection_id=c.id and a.parent_page_id is not null) inventory
      on conflict(subject_hash,connection_id) do nothing;
    update public.meta_connections set status='revoked',oauth_access_token_encrypted=null,revoked_at=now(),version=version+1
      where id=c.id and organization_id=c.organization_id;
    update public.meta_asset_grants set status='revoked',selected=false,page_access_token_encrypted=null
      where organization_id=c.organization_id and connection_id=c.id;
    update public.meta_operations set status=case when external_dispatch_started_at is null then 'cancelled' else 'uncertain' end,
      error_code='meta_privacy_requested',error_message=null,lease_owner=null,lease_until=null,fence=fence+1
      where organization_id=c.organization_id and connection_id=c.id and status in ('queued','executing','awaiting_provider');
    update public.meta_oauth_attempts set status='failed',failure_code='meta_privacy_requested',pending_result_encrypted=null,ticket_hash=null
      where organization_id=c.organization_id and actor_id=c.local_actor_id and app_id=c.app_id and (status in ('pending','exchanging') or (status='ready' and
        public.fn_decrypt_oauth(pending_result_encrypted)::jsonb->>'remote_actor_id'=p_remote_actor_id));
  end loop;
  return jsonb_build_object('request_id',receipt.id,'confirmation_code_encrypted',receipt.confirmation_code_encrypted,'status',receipt.status);
end $$;
revoke all on function public.fn_meta_privacy_request(text,text,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_meta_privacy_request(text,text,text,text,text,timestamptz) to service_role;

create or replace function public.fn_meta_privacy_claim(p_worker_id text,p_lease_seconds integer default 90)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare receipt public.meta_privacy_requests;
begin
  if p_worker_id is null or length(p_worker_id) not between 1 and 200 or p_lease_seconds is null or p_lease_seconds not between 5 and 300 then
    raise exception 'meta_privacy_lease_invalid' using errcode='22023'; end if;
  select * into receipt from public.meta_privacy_requests r where r.status<>'completed'
    and r.retry_at<=now() and (r.lease_until is null or r.lease_until<=now()) order by r.retry_at,r.created_at,r.id for update skip locked limit 1;
  if not found then return null; end if;
  update public.meta_privacy_requests set status='processing',lease_owner=p_worker_id,
    lease_until=now()+make_interval(secs=>p_lease_seconds),fence=fence+1 where id=receipt.id returning * into receipt;
  return jsonb_build_object('id',receipt.id,'fence',receipt.fence,'lease_until',receipt.lease_until);
end $$;
revoke all on function public.fn_meta_privacy_claim(text,integer) from public,anon,authenticated;
grant execute on function public.fn_meta_privacy_claim(text,integer) to service_role;

create or replace function public.fn_meta_privacy_step(
  p_request_id uuid,p_worker_id text,p_fence bigint,p_storage_object_ids uuid[] default '{}',p_limit integer default 100
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare receipt public.meta_privacy_requests; target public.meta_privacy_targets; connection_lock bigint;
  pub_ids uuid[]; v_publication_id uuid; all_locked boolean; operation_ids uuid[]; bounded integer; objects jsonb; more boolean;
begin
  bounded:=greatest(10,least(coalesce(p_limit,100),100));
  select * into receipt from public.meta_privacy_requests r where r.id=p_request_id;
  if not found then raise exception 'meta_privacy_request_missing' using errcode='PT404'; end if;
  perform pg_advisory_xact_lock(hashtextextended('meta-privacy-subject:'||receipt.subject_hash,0));
  select * into receipt from public.meta_privacy_requests r where r.id=p_request_id and r.status='processing'
    and r.lease_owner=p_worker_id and r.fence=p_fence and r.lease_until>now() for update;
  if not found then raise exception 'meta_privacy_lease_lost' using errcode='PT409'; end if;
  if p_storage_object_ids is null or cardinality(p_storage_object_ids)>100 or exists(
    select 1 from unnest(p_storage_object_ids) ack where not exists(select 1 from public.meta_privacy_storage_objects o where o.id=ack and o.subject_hash=receipt.subject_hash)) then
    raise exception 'meta_privacy_ack_invalid' using errcode='22023'; end if;
  delete from public.meta_privacy_storage_objects o where o.subject_hash=receipt.subject_hash and o.id=any(p_storage_object_ids);
  -- Processing one connection uses the same lock as preparation's shared lock.
  -- A busy upload leaves the receipt pending without blocking the callback.
  select * into target from public.meta_privacy_targets t where t.subject_hash=receipt.subject_hash order by t.connection_id limit 1 for update;
  if found and not exists(select 1 from public.meta_privacy_storage_objects o where o.subject_hash=receipt.subject_hash) then
    connection_lock:=hashtextextended('meta-privacy-connection:'||target.connection_id,0);
    if pg_try_advisory_lock(connection_lock) then
      begin
        if exists(select 1 from public.instagram_publications p where p.provider='meta' and p.organization_id=target.organization_id
          and p.meta_connection_id=target.connection_id and p.meta_media_cleanup_uncertain) then
          -- Client AbortSignal does not prove that Storage stopped writing bytes.
          -- Keep provenance until a trusted operator proves physical removal.
          -- Tombstones can still prevent a later metadata commit; no elapsed
          -- timeout is treated as evidence of successful physical cleanup.
          for v_publication_id in select p.id from public.instagram_publications p where p.provider='meta' and p.organization_id=target.organization_id
            and p.meta_connection_id=target.connection_id and p.meta_media_cleanup_uncertain order by p.id limit bounded loop
            if pg_try_advisory_xact_lock(hashtextextended('meta-privacy-publication:'||target.organization_id::text||':'||v_publication_id::text,0)) then
              insert into public.meta_privacy_media_tombstones(organization_id,publication_id)
                values(target.organization_id,v_publication_id) on conflict do nothing;
            end if;
          end loop;
          update public.meta_privacy_requests set status='pending',lease_owner=null,lease_until=null,retry_at=now()+interval '5 minutes',fence=fence+1 where id=receipt.id;
          perform pg_advisory_unlock(connection_lock);
          return jsonb_build_object('status','pending','more',true,'storage_objects','[]'::jsonb);
        end if;
        select array_agg(p.id) into pub_ids from (select p.id from public.instagram_publications p
          where p.provider='meta' and p.organization_id=target.organization_id and p.meta_connection_id=target.connection_id
          order by p.id limit greatest(1,bounded/10) for update skip locked) p;
        if pub_ids is not null then
          all_locked:=true;
          foreach v_publication_id in array pub_ids loop
            if not pg_try_advisory_xact_lock(hashtextextended('meta-privacy-publication:'||target.organization_id::text||':'||v_publication_id::text,0)) then
              all_locked:=false; exit;
            end if;
          end loop;
          if all_locked then
          insert into public.meta_privacy_media_tombstones(organization_id,publication_id)
            select target.organization_id,pub_id from unnest(pub_ids) pub_id on conflict do nothing;
          insert into public.meta_privacy_storage_objects(subject_hash,organization_id,publication_id,object_index)
            select receipt.subject_hash,target.organization_id,pub_id,i from unnest(pub_ids) pub_id cross join generate_series(0,9) i
            on conflict(subject_hash,organization_id,publication_id,object_index) do nothing;
          delete from public.instagram_publications p where p.organization_id=target.organization_id and p.provider='meta' and p.id=any(pub_ids);
          end if;
        elsif not exists(select 1 from public.instagram_publications p where p.provider='meta' and p.organization_id=target.organization_id and p.meta_connection_id=target.connection_id) then
          select array_agg(o.id) into operation_ids from (select o.id from public.meta_operations o
            where o.organization_id=target.organization_id and o.connection_id=target.connection_id order by o.id limit bounded for update skip locked) o;
          if operation_ids is not null then
            delete from public.event_log e where e.organization_id=target.organization_id and e.entity_kind='meta_operation'
              and e.event_type='meta.operation_requested' and e.entity_id=any(operation_ids);
            delete from public.meta_operations o where o.organization_id=target.organization_id and o.connection_id=target.connection_id and o.id=any(operation_ids);
          elsif not exists(select 1 from public.meta_operations o where o.organization_id=target.organization_id and o.connection_id=target.connection_id) then
            delete from public.meta_campaign_drafts d where d.organization_id=target.organization_id and d.meta_connection_id=target.connection_id
              and d.id in (select x.id from public.meta_campaign_drafts x where x.organization_id=target.organization_id and x.meta_connection_id=target.connection_id
                order by x.id limit bounded for update skip locked);
            if not exists(select 1 from public.meta_campaign_drafts d where d.organization_id=target.organization_id and d.meta_connection_id=target.connection_id) then
              delete from public.meta_asset_grants g where g.organization_id=target.organization_id and g.connection_id=target.connection_id
                and g.id in (select x.id from public.meta_asset_grants x where x.organization_id=target.organization_id and x.connection_id=target.connection_id order by x.id limit bounded for update skip locked);
              if not exists(select 1 from public.meta_asset_grants g where g.organization_id=target.organization_id and g.connection_id=target.connection_id) then
                delete from public.meta_oauth_attempts a where a.id in (
                  select x.id from public.meta_oauth_attempts x where x.organization_id=target.organization_id and x.app_id=receipt.app_id
                    and exists(select 1 from public.meta_connections c where c.organization_id=target.organization_id and c.id=target.connection_id and c.local_actor_id=x.actor_id)
                    and x.status in ('failed','expired') order by x.id limit bounded for update skip locked);
                if not exists(select 1 from public.meta_oauth_attempts a where a.organization_id=target.organization_id and a.app_id=receipt.app_id
                  and exists(select 1 from public.meta_connections c where c.organization_id=target.organization_id and c.id=target.connection_id and c.local_actor_id=a.actor_id)
                  and a.status in ('failed','expired')) then
                  delete from public.meta_connections c where c.organization_id=target.organization_id and c.id=target.connection_id;
                -- Leaves first; the next batch discovers Pages newly orphaned
                -- by this batch. Shared authority and originals remain intact.
                with doomed as (select a.id from public.meta_assets a where a.organization_id=target.organization_id and a.id=any(target.asset_ids)
                  and (a.kind='instagram' or (a.kind in ('page','ad_account')
                    and not exists(select 1 from public.meta_assets child where child.organization_id=a.organization_id and child.parent_page_id=a.id)))
                  and not exists(select 1 from public.meta_asset_grants g where g.organization_id=a.organization_id and g.asset_id=a.id)
                  and not exists(select 1 from public.meta_operations o where o.organization_id=a.organization_id and o.asset_id=a.id)
                  and not exists(select 1 from public.instagram_publications p where p.organization_id=a.organization_id and p.meta_asset_id=a.id)
                  and not exists(select 1 from public.meta_campaign_drafts d where d.organization_id=a.organization_id and a.id in (d.ad_account_asset_id,d.page_asset_id,d.instagram_asset_id))
                  order by case when a.kind='instagram' then 0 else 1 end,a.id limit bounded for update skip locked)
                delete from public.meta_assets a using doomed d where a.id=d.id and a.organization_id=target.organization_id;
                if not exists(select 1 from public.meta_assets a where a.organization_id=target.organization_id and a.id=any(target.asset_ids)
                  and (a.kind='instagram' or (a.kind in ('page','ad_account')
                    and not exists(select 1 from public.meta_assets child where child.organization_id=a.organization_id and child.parent_page_id=a.id)))
                  and not exists(select 1 from public.meta_asset_grants g where g.organization_id=a.organization_id and g.asset_id=a.id)
                  and not exists(select 1 from public.meta_operations o where o.organization_id=a.organization_id and o.asset_id=a.id)
                  and not exists(select 1 from public.instagram_publications p where p.organization_id=a.organization_id and p.meta_asset_id=a.id)
                  and not exists(select 1 from public.meta_campaign_drafts d where d.organization_id=a.organization_id and a.id in (d.ad_account_asset_id,d.page_asset_id,d.instagram_asset_id))) then
                  delete from public.meta_privacy_targets t where t.subject_hash=receipt.subject_hash and t.connection_id=target.connection_id;
                end if;
                end if;
              end if;
            end if;
          end if;
        end if;
        perform pg_advisory_unlock(connection_lock);
      exception
        when query_canceled or assert_failure then
          perform pg_advisory_unlock(connection_lock);
          raise;
        when others then
          perform pg_advisory_unlock(connection_lock);
          raise;
      end;
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'organization_id',o.organization_id,'publication_id',o.publication_id,'index',o.object_index,
    'path',o.organization_id::text||'/instagram/publications/'||o.publication_id::text||'/'||o.object_index::text||'.jpg') order by o.created_at,o.id),'[]')
    into objects from (select * from public.meta_privacy_storage_objects s where s.subject_hash=receipt.subject_hash order by s.created_at,s.id limit bounded) o;
  more:=exists(select 1 from public.meta_privacy_targets t where t.subject_hash=receipt.subject_hash)
    or exists(select 1 from public.meta_privacy_storage_objects o where o.subject_hash=receipt.subject_hash);
  if not more then
    update public.meta_privacy_subjects set status='completed',updated_at=now() where subject_hash=receipt.subject_hash;
    update public.meta_privacy_requests set status='completed',completed_at=now(),lease_owner=null,lease_until=null,fence=fence+1
      where subject_hash=receipt.subject_hash and status<>'completed';
  else
    update public.meta_privacy_requests set lease_until=now()+interval '90 seconds' where id=receipt.id;
  end if;
  return jsonb_build_object('status',case when more then 'processing' else 'completed' end,'more',more,'storage_objects',objects);
end $$;
revoke all on function public.fn_meta_privacy_step(uuid,text,bigint,uuid[],integer) from public,anon,authenticated;
grant execute on function public.fn_meta_privacy_step(uuid,text,bigint,uuid[],integer) to service_role;


-- The 0416 bodies retain their existing guards; these narrow additions enforce
-- privacy barriers at configuration, OAuth finalization and every dispatch.
do $meta_privacy_core_upgrade$
begin
  if exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)')
    and md5(p.prosrc) in ('af56fbc10a73e4c28395994ff694641c','a992f49f51858ac7a8a3eb85bf464193')) then
    execute $definition$
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
  if p_app_id is distinct from config.app_id and (
    exists(select 1 from public.meta_connections c where c.app_id=config.app_id)
    or exists(select 1 from public.meta_privacy_requests r where r.app_id=config.app_id and r.status<>'completed')) then
    raise exception 'meta_app_identity_in_use' using errcode='PT409'; end if;
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
$definition$;
  elsif coalesce(obj_description(to_regprocedure('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)'),'pg_proc'),'') not like 'meta-privacy-0417-%' then
    raise exception 'meta_privacy_core_unknown' using errcode='55000';
  end if;
end $meta_privacy_core_upgrade$;
revoke all on function public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea) from public,anon,authenticated;
grant execute on function public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea) to service_role;

do $meta_privacy_core_upgrade$
begin
  if exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.fn_meta_oauth_finalize(uuid,uuid,text,text)')
    and md5(p.prosrc) in ('166333c3e3c189becdb3bb0e86106fd3','a358ecdb7ca5882830d8e9b83e58f75a')) then
    execute $definition$
create or replace function public.fn_meta_oauth_finalize(
  p_organization_id uuid,p_actor_id uuid,p_auth_session_id text,p_ticket_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  attempt public.meta_oauth_attempts;
  connection public.meta_connections;
  payload jsonb;
  remote_id text;
  subject text;
  cutoff timestamptz;
begin
  perform public.fn_meta_require_actor(p_organization_id,p_actor_id,'admin');
  perform pg_advisory_xact_lock_shared(416,1);
  -- Read before locking the attempt: callbacks take subject then attempt locks.
  -- After acquiring the subject mutex the row and encrypted result are checked
  -- again under FOR UPDATE, preventing a stale read or a lock-order deadlock.
  select a.* into attempt from public.meta_oauth_attempts a
    where a.organization_id=p_organization_id and a.actor_id=p_actor_id
      and a.auth_session_id=p_auth_session_id and a.ticket_hash=p_ticket_hash
      and a.status='ready' and a.expires_at>now();
  if not found then raise exception 'meta_oauth_finalize_invalid' using errcode='PT400'; end if;
  payload:=public.fn_decrypt_oauth(attempt.pending_result_encrypted)::jsonb;
  remote_id:=payload->>'remote_actor_id';
  subject:=public.fn_meta_privacy_subject_hash(attempt.app_id,remote_id);
  perform pg_advisory_xact_lock(hashtextextended('meta-privacy-subject:'||subject,0));
  select s.cutoff_at into cutoff from public.meta_privacy_subjects s where s.subject_hash=subject;
  if found and (attempt.created_at<=cutoff or exists(select 1 from public.meta_privacy_subjects s
    where s.subject_hash=subject and s.status='pending')) then
    raise exception 'meta_privacy_authorization_unavailable' using errcode='PT409'; end if;
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
  if public.fn_meta_privacy_subject_hash(attempt.app_id,remote_id)<>subject then
    raise exception 'meta_oauth_finalize_invalid' using errcode='PT400'; end if;
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
$definition$;
  elsif coalesce(obj_description(to_regprocedure('public.fn_meta_oauth_finalize(uuid,uuid,text,text)'),'pg_proc'),'') not like 'meta-privacy-0417-%' then
    raise exception 'meta_privacy_core_unknown' using errcode='55000';
  end if;
end $meta_privacy_core_upgrade$;
revoke all on function public.fn_meta_oauth_finalize(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.fn_meta_oauth_finalize(uuid,uuid,text,text) to service_role;

do $meta_privacy_core_upgrade$
begin
  if exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.fn_meta_operation_authorized(uuid)')
    and md5(p.prosrc) in ('1b050b0ffcae618822107679dcfefa38','0b3db39988da722420965b9b114a8260')) then
    execute $definition$
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
    where o.id=p_operation_id and not exists(select 1 from public.meta_privacy_subjects subject
      where subject.subject_hash=public.fn_meta_privacy_subject_hash(c.app_id,c.remote_actor_id) and subject.status='pending')
      and c.status='healthy' and c.oauth_access_token_encrypted is not null
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
$definition$;
  elsif coalesce(obj_description(to_regprocedure('public.fn_meta_operation_authorized(uuid)'),'pg_proc'),'') not like 'meta-privacy-0417-%' then
    raise exception 'meta_privacy_core_unknown' using errcode='55000';
  end if;
end $meta_privacy_core_upgrade$;
revoke all on function public.fn_meta_operation_authorized(uuid) from public,anon,authenticated;
grant execute on function public.fn_meta_operation_authorized(uuid) to service_role;

do $meta_privacy_core_marker$ begin if coalesce(obj_description(to_regprocedure('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)'),'pg_proc'),'') not like 'meta-privacy-0417-%' then execute $marker$comment on function public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea) is 'meta-privacy-0417-v1';$marker$; end if; end $meta_privacy_core_marker$;
do $meta_privacy_core_marker$ begin if coalesce(obj_description(to_regprocedure('public.fn_meta_oauth_finalize(uuid,uuid,text,text)'),'pg_proc'),'') not like 'meta-privacy-0417-%' then execute $marker$comment on function public.fn_meta_oauth_finalize(uuid,uuid,text,text) is 'meta-privacy-0417-v1';$marker$; end if; end $meta_privacy_core_marker$;
do $meta_privacy_core_marker$ begin if coalesce(obj_description(to_regprocedure('public.fn_meta_operation_authorized(uuid)'),'pg_proc'),'') not like 'meta-privacy-0417-%' then execute $marker$comment on function public.fn_meta_operation_authorized(uuid) is 'meta-privacy-0417-v1';$marker$; end if; end $meta_privacy_core_marker$;
comment on table public.meta_privacy_subjects is 'Keyed, purpose-limited suppression digest and OAuth cutoff; raw provider identity is not retained after erasure.';
notify pgrst,'reload schema';
