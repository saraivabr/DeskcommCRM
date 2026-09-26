create table if not exists public.mcp_oauth_clients (
  id uuid primary key default gen_random_uuid(), name text not null,
  redirect_uris jsonb not null, created_at timestamptz not null default now()
);
create table if not exists public.mcp_connections (
  id uuid primary key references public.api_tokens(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id uuid references public.mcp_oauth_clients(id),
  name text not null, created_at timestamptz not null default now(), revoked_at timestamptz,
  unique(organization_id,id)
);
create table if not exists public.mcp_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.mcp_connections(id) on delete cascade,
  client_id uuid not null references public.mcp_oauth_clients(id),
  kind text not null check(kind in ('code','refresh')),
  secret_hash text not null unique, challenge text, redirect_uri text, resource text not null,
  expires_at timestamptz not null, consumed_at timestamptz
);
create table if not exists public.mcp_action_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  user_id uuid not null references auth.users(id),
  tool_name text not null, args jsonb not null, args_hash text not null,
  status text not null default 'pending' check(status in ('pending','approved','executing','completed','failed','rejected')),
  result jsonb, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '15 minutes',
  foreign key(organization_id,connection_id) references public.mcp_connections(organization_id,id) on delete cascade
);
create unique index if not exists mcp_action_pending on public.mcp_action_approvals(connection_id,tool_name,args_hash)
  where status in ('pending','approved','executing');
alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_connections enable row level security;
alter table public.mcp_oauth_grants enable row level security;
alter table public.mcp_action_approvals enable row level security;
revoke all on public.mcp_oauth_clients,public.mcp_connections,public.mcp_oauth_grants,public.mcp_action_approvals from anon,authenticated;
grant all on public.mcp_oauth_clients,public.mcp_connections,public.mcp_oauth_grants,public.mcp_action_approvals to service_role;

-- Code consumption, refresh rotation and access-token replacement are one transaction.
create or replace function public.fn_mcp_exchange_grant(p_hash text,p_kind text,p_client uuid,p_redirect text,
  p_challenge text,p_resource text,p_access_hash text,p_refresh_hash text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare g public.mcp_oauth_grants; c public.mcp_connections; t public.api_tokens;
begin
  select * into g from mcp_oauth_grants where secret_hash=p_hash for update;
  if not found or g.consumed_at is not null or g.expires_at<=now() or g.kind<>p_kind or g.client_id<>p_client
    or g.resource<>p_resource or (p_kind='code' and (g.redirect_uri is distinct from p_redirect or g.challenge is distinct from p_challenge))
    then raise exception 'invalid_grant' using errcode='PT400'; end if;
  select * into c from mcp_connections where id=g.connection_id for update;
  select * into t from api_tokens where id=c.id for update;
  if c.revoked_at is not null or t.revoked_at is not null or not exists
    (select 1 from user_organizations where user_id=c.user_id and organization_id=c.organization_id)
    then raise exception 'invalid_grant' using errcode='PT400'; end if;
  update mcp_oauth_grants set consumed_at=now() where id=g.id;
  update api_tokens set token_hash=decode(p_access_hash,'hex'),expires_at=now()+interval '1 hour' where id=c.id;
  insert into mcp_oauth_grants(connection_id,client_id,kind,secret_hash,resource,expires_at)
    values(c.id,p_client,'refresh',p_refresh_hash,p_resource,now()+interval '30 days');
  return jsonb_build_object('scopes',t.scopes);
end $$;
revoke all on function public.fn_mcp_exchange_grant(text,text,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.fn_mcp_exchange_grant(text,text,uuid,text,text,text,text,text) to service_role;
