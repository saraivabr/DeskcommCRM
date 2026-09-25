-- Durable dispatch intent: an uncertain HTTP write must never be resent blindly.
create table if not exists public.instagram_publications (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  account_id text not null,
  item_ids uuid[] not null check (cardinality(item_ids) between 1 and 10),
  format text not null check (format in ('feed','story','carousel')),
  caption text not null default '',
  status text not null default 'preparing' check (status in ('preparing','sending','pending','published','failed','uncertain')),
  provider_post_id text,
  permalink text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists instagram_publications_org_created on public.instagram_publications(organization_id,created_at desc);
alter table public.instagram_publications enable row level security;
drop policy if exists tenant_isolation_instagram_publications_all on public.instagram_publications;
create policy tenant_isolation_instagram_publications_all on public.instagram_publications for select to authenticated using (organization_id in (select public.fn_user_org_ids()));
revoke all on public.instagram_publications from anon, authenticated;
grant select on public.instagram_publications to authenticated;
grant all on public.instagram_publications to service_role;
notify pgrst, 'reload schema';
