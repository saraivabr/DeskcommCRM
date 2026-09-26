-- Shared documents; all mutations go through the revision-checked transaction.
create table if not exists public.knowledge_pages (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.ai_knowledge_sources(id),
  parent_id uuid,
  title text not null check (length(title) between 1 and 120),
  markdown text not null default '' check (length(markdown) <= 200000),
  blocks jsonb not null default '[]'::jsonb check (jsonb_typeof(blocks)='array'),
  revision integer not null default 1 check (revision > 0),
  indexed_revision integer not null default 0,
  archived boolean not null default false,
  source_url text,
  original_path text,
  updated_by uuid not null references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, parent_id) references public.knowledge_pages(organization_id,id),
  check (parent_id is distinct from id)
);
create index if not exists knowledge_pages_org on public.knowledge_pages(organization_id, updated_at desc);
create index if not exists knowledge_pages_text on public.knowledge_pages using gin
  (to_tsvector('portuguese', title || ' ' || markdown));
create table if not exists public.knowledge_page_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  page_id uuid not null,
  revision integer not null,
  title text not null,
  markdown text not null,
  blocks jsonb not null default '[]'::jsonb,
  parent_id uuid,
  archived boolean not null,
  actor_id uuid not null references auth.users(id),
  operation_id uuid not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id,page_id) references public.knowledge_pages(organization_id,id) on delete cascade,
  unique(organization_id,operation_id), unique(page_id,revision)
);
create table if not exists public.knowledge_page_favorites (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  page_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key(page_id,user_id),
  foreign key(organization_id,page_id) references public.knowledge_pages(organization_id,id) on delete cascade
);
alter table public.knowledge_pages enable row level security;
alter table public.knowledge_page_revisions enable row level security;
alter table public.knowledge_page_favorites enable row level security;
revoke all on public.knowledge_pages, public.knowledge_page_revisions, public.knowledge_page_favorites from anon, authenticated;
grant select on public.knowledge_pages, public.knowledge_page_revisions to authenticated;
grant select, insert, delete on public.knowledge_page_favorites to authenticated;
grant all on public.knowledge_pages, public.knowledge_page_revisions, public.knowledge_page_favorites to service_role;
drop policy if exists knowledge_pages_read on public.knowledge_pages;
create policy knowledge_pages_read on public.knowledge_pages for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists knowledge_revisions_read on public.knowledge_page_revisions;
create policy knowledge_revisions_read on public.knowledge_page_revisions for select to authenticated
  using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists knowledge_favorites_own on public.knowledge_page_favorites;
create policy knowledge_favorites_own on public.knowledge_page_favorites for all to authenticated
  using (user_id = auth.uid() and organization_id in (select public.fn_user_org_ids()))
  with check (user_id = auth.uid() and organization_id in (select public.fn_user_org_ids()));

create or replace function public.fn_save_knowledge_page(
  p_org uuid, p_actor uuid, p_input jsonb, p_origin jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  current_page public.knowledge_pages; saved public.knowledge_pages;
  prior public.knowledge_page_revisions; source uuid; parent uuid;
  page uuid := (p_input->>'id')::uuid;
  op uuid := (p_input->>'operation_id')::uuid;
  request_hash text := md5(p_input::text || p_origin::text);
begin
  if not exists(select 1 from user_organizations where user_id=p_actor and organization_id=p_org
    and role in ('agent','manager','admin')) then raise exception 'forbidden' using errcode='42501'; end if;
  -- Serialize hierarchy changes and operation retries within the organization.
  perform pg_advisory_xact_lock(hashtextextended('knowledge:' || p_org::text,0));
  select * into prior from knowledge_page_revisions where organization_id=p_org and operation_id=op;
  if found then
    if prior.request_hash <> request_hash or prior.actor_id <> p_actor then
      raise exception 'operation_conflict' using errcode='PT409'; end if;
    select * into saved from knowledge_pages where organization_id=p_org and id=prior.page_id;
    return to_jsonb(saved);
  end if;
  select * into current_page from knowledge_pages where organization_id=p_org and id=page for update;
  if coalesce(current_page.revision,0) <> (p_input->>'expected_revision')::integer then
    raise exception 'revision_conflict' using errcode='PT409'; end if;
  parent := (p_input->>'parent_id')::uuid;
  if parent is not null then
    if not exists(select 1 from knowledge_pages where id=parent and organization_id=p_org and not archived) then
      raise exception 'parent_not_found' using errcode='PT422'; end if;
    if exists(with recursive ancestors as (
      select id,parent_id from knowledge_pages where id=parent and organization_id=p_org
      union all select p.id,p.parent_id from knowledge_pages p join ancestors a on p.id=a.parent_id
        where p.organization_id=p_org
    ) select 1 from ancestors where id=page) then raise exception 'parent_cycle' using errcode='PT422'; end if;
  end if;
  source := current_page.source_id;
  if source is null then
    insert into ai_knowledge_sources(organization_id,name,source_type,is_active,source_metadata)
      values(p_org, left(p_input->>'title',75) || ' · ' || page::text, 'documento',true,
        jsonb_build_object('knowledge_page_id',page)) returning id into source;
    insert into knowledge_pages(id,organization_id,source_id,title,markdown,parent_id,updated_by,
      archived,source_url,original_path,blocks)
      values(page,p_org,source,p_input->>'title',p_input->>'markdown',parent,p_actor,
        (p_input->>'archived')::boolean,p_origin->>'source_url',p_origin->>'original_path',coalesce(p_input->'blocks','[]'::jsonb)) returning * into saved;
  else
    update knowledge_pages set title=p_input->>'title',markdown=p_input->>'markdown',parent_id=parent,
      blocks=coalesce(p_input->'blocks','[]'::jsonb),revision=revision+1, archived=(p_input->>'archived')::boolean,updated_by=p_actor,updated_at=now()
      where id=page and organization_id=p_org returning * into saved;
  end if;
  update ai_knowledge_sources set is_active=not saved.archived,
    name=left(saved.title,75) || ' · ' || page::text,
    source_metadata=source_metadata || jsonb_build_object('page_revision',saved.revision),updated_at=now()
    where id=source and organization_id=p_org;
  insert into knowledge_page_revisions(organization_id,page_id,revision,title,markdown,parent_id,archived,actor_id,operation_id,request_hash,blocks)
    values(p_org,page,saved.revision,saved.title,saved.markdown,parent,saved.archived,p_actor,op,request_hash,saved.blocks);
  if not saved.archived and length(trim(saved.markdown)) > 0 then
    perform public.emit_event(p_organization_id=>p_org,p_event_type=>'knowledge_source.updated',
      p_entity_kind=>'ai_knowledge_source',p_entity_id=>source,
      p_payload=>jsonb_build_object('knowledge_source_id',source,'source_type','documento'));
  end if;
  return to_jsonb(saved);
end $$;
revoke all on function public.fn_save_knowledge_page(uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.fn_save_knowledge_page(uuid,uuid,jsonb,jsonb) to service_role;

-- Compare-and-swap activation holds the same page lock as a save; an old worker cannot win.
create or replace function public.fn_activate_knowledge_page(p_org uuid,p_page uuid,p_revision integer,p_version uuid)
returns boolean language plpgsql security invoker set search_path=public as $$
declare p public.knowledge_pages;
begin
  select * into p from knowledge_pages where id=p_page and organization_id=p_org for update;
  if not found or p.archived or p.revision<>p_revision then return false; end if;
  if not exists(select 1 from ai_knowledge_versions where id=p_version and organization_id=p_org
    and knowledge_source_id=p.source_id and status='ready') then return false; end if;
  update ai_knowledge_versions set is_active=false where organization_id=p_org and knowledge_source_id=p.source_id;
  update ai_knowledge_versions set is_active=true where organization_id=p_org and id=p_version;
  update ai_knowledge_sources set active_kb_version_id=p_version where organization_id=p_org and id=p.source_id;
  update knowledge_pages set indexed_revision=p_revision where organization_id=p_org and id=p_page;
  return true;
end $$;
revoke all on function public.fn_activate_knowledge_page(uuid,uuid,integer,uuid) from public, anon, authenticated;
grant execute on function public.fn_activate_knowledge_page(uuid,uuid,integer,uuid) to service_role;

create or replace function public.fn_search_knowledge_pages(p_org uuid,p_query text,p_limit integer default 10)
returns table(id uuid,title text,excerpt text,revision integer,source_url text)
language sql stable security invoker set search_path=public as $$
  select p.id,p.title,left(p.markdown,1600),p.revision,p.source_url
  from knowledge_pages p
  where p.organization_id=p_org and not p.archived and length(trim(p.markdown))>0
    and (to_tsvector('portuguese',p.title || ' ' || p.markdown) @@ plainto_tsquery('portuguese',p_query)
      or p.title ilike '%' || replace(replace(replace(p_query,'\','\\'),'%','\%'),'_','\_') || '%')
  order by ts_rank(to_tsvector('portuguese',p.title || ' ' || p.markdown),plainto_tsquery('portuguese',p_query)) desc,p.updated_at desc
  limit greatest(1,least(p_limit,20));
$$;
revoke all on function public.fn_search_knowledge_pages(uuid,text,integer) from public,anon;
grant execute on function public.fn_search_knowledge_pages(uuid,text,integer) to authenticated,service_role;
