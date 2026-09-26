-- User-bound external effects reserve before dispatch. Interrupted effects never auto-retry.
create table if not exists public.mcp_operation_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  tool_name text not null,
  operation_key text not null check(length(operation_key) between 1 and 200),
  request_hash text not null check(length(request_hash)=64),
  status text not null default 'executing' check(status in ('executing','completed','uncertain')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key(organization_id,connection_id) references public.mcp_connections(organization_id,id) on delete cascade,
  unique(connection_id,tool_name,operation_key)
);
alter table public.mcp_operation_receipts enable row level security;
revoke all on public.mcp_operation_receipts from anon,authenticated;
grant all on public.mcp_operation_receipts to service_role;
notify pgrst, 'reload schema';
