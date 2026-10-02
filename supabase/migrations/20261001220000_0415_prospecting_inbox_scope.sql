-- 0415 — the campaign seller is available only to its exact prospect conversation.
-- Computed PostgREST field: filters execute before pagination without an ID list
-- in the request URL. It returns no campaign, prompt or candidate information.
-- Prospecting tables remain service-only. The definer reads the stored row and
-- checks the SAME conversation visibility rule before returning this boolean;
-- callers cannot manufacture access by forging the composite argument.
create or replace function public.automatico_da_prospeccao(c public.conversations)
returns boolean
language sql stable security definer
set search_path = ''
as $prospecting_scope$
  select exists (
    select 1
    from public.conversations actual
    join public.prospecting_candidates p
      on p.organization_id = actual.organization_id and p.conversation_id = actual.id
    join public.prospecting_campaigns campaign
      on campaign.organization_id = p.organization_id and campaign.id = p.campaign_id
    join public.ai_agents a
      on a.organization_id = campaign.organization_id and a.id::text = campaign.config->>'agent_id'
    join public.ai_agent_versions v
      on v.organization_id = a.organization_id and v.agent_id = a.id and v.id = a.published_version_id
    where actual.id = c.id and actual.organization_id = c.organization_id
      and (coalesce(auth.jwt()->>'role', '') = 'service_role'
        or public.fn_can_view_conversation(actual.organization_id, actual.assigned_to_user_id))
      and p.status in ('sending', 'sent')
      and campaign.config->>'channel_session_id' = actual.channel_session_id::text
      and campaign.config->>'pipeline_id' is not null
      and a.config @> '{"managed_by":"prospecting","standard_seller":true}'::jsonb
      and a.archived_at is null and a.paused_at is null and a.operation_mode = 'automatic'
      and v.status = 'published'
  );
$prospecting_scope$;

comment on function public.automatico_da_prospeccao(public.conversations) is
  'Computed Inbox availability for the published standard prospecting seller: exact tenant, conversation, campaign and channel; never general channel attendance (0415).';
revoke execute on function public.automatico_da_prospeccao(public.conversations) from public, anon;
grant execute on function public.automatico_da_prospeccao(public.conversations) to authenticated, service_role;
notify pgrst, 'reload schema';
