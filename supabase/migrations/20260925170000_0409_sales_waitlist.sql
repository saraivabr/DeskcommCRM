-- Platform prospect intake exists before any tenant/account: intentionally no organization_id.
create table if not exists public.sales_waitlist (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  company text not null default '' check (char_length(company) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  invited_at timestamptz,
  invited_organization_id uuid references public.organizations(id) on delete set null
);
alter table public.sales_waitlist enable row level security;
revoke all on table public.sales_waitlist from public, anon, authenticated, service_role;
grant select, insert, update on table public.sales_waitlist to service_role;
create index if not exists sales_waitlist_invited_organization_idx
  on public.sales_waitlist(invited_organization_id) where invited_organization_id is not null;
comment on table public.sales_waitlist is 'Platform sales waitlist; intake never provisions users, tenants or invitations. Service role only; platform admin guards protect the operator view.';
