alter table public.prospecting_settings
  add column if not exists schedule_config jsonb,
  add column if not exists schedule_enabled boolean not null default false,
  add column if not exists schedule_runs integer not null default 0,
  add column if not exists schedule_reserved_usd numeric(12,2) not null default 0,
  add column if not exists schedule_next_at timestamptz,
  add column if not exists schedule_request_id uuid,
  add column if not exists schedule_campaign_id uuid,
  add column if not exists schedule_error text;

alter table public.prospecting_settings drop constraint if exists prospecting_schedule_campaign_tenant;
alter table public.prospecting_settings add constraint prospecting_schedule_campaign_tenant
  foreign key (organization_id,schedule_campaign_id)
  references public.prospecting_campaigns(organization_id,id) on delete set null (schedule_campaign_id);
alter table public.prospecting_settings drop constraint if exists prospecting_schedule_limits;
alter table public.prospecting_settings add constraint prospecting_schedule_limits check (
  schedule_runs >= 0 and schedule_reserved_usd >= 0
  and (not schedule_enabled or schedule_config is not null)
);
-- Credentials and scheduling remain server-only under the existing tenant boundary.
revoke all on public.prospecting_settings from anon, authenticated;
