-- 0418 · Native Instagram Direct / Messenger share Inbox, not Zernio credentials.
-- Refuse unknown self-hosted core bodies, including a concurrent custom upgrade.
do $meta_messaging_known_core$
begin
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.fn_emit_message_event()')
   and md5(prosrc) in ('1277798a1587cfd0a46df1be2f6511ac','d2984c63e6fbc7926459d9584369df4d')) then
   raise exception 'meta_messaging_core_unknown' using errcode='55000';
 end if;
end $meta_messaging_known_core$;
alter table public.channel_sessions
  add column if not exists meta_social_asset_id uuid,
  add column if not exists meta_social_connection_id uuid,
  add column if not exists meta_social_external_id text;
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check
 check(provider in ('waha','meta_cloud','zernio','zernio_social','wacalls','datafy','meta_social'));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check(
 (provider='waha' and waha_session_name is not null) or
 (provider='meta_cloud' and meta_phone_number_id is not null) or
 (provider in ('zernio','zernio_social') and zernio_account_id is not null) or
 (provider='wacalls' and wacalls_session_id is not null) or
 (provider='datafy' and datafy_phone_number_id is not null) or
 (provider='meta_social' and (meta_social_external_id is not null or archived_at is not null)));
-- New columns start empty; no existing records can violate these new unique constraints.
create unique index if not exists channel_sessions_meta_social_external_active_unique
 on public.channel_sessions(meta_social_external_id) where provider='meta_social' and archived_at is null;
create unique index if not exists channel_sessions_meta_social_asset_active_unique
 on public.channel_sessions(organization_id,meta_social_asset_id) where provider='meta_social' and archived_at is null;
-- No service-role lookup may bind an asset or connection from a different tenant.
alter table public.channel_sessions drop constraint if exists channel_sessions_meta_social_asset_fk;
alter table public.channel_sessions add constraint channel_sessions_meta_social_asset_fk
 foreign key(organization_id,meta_social_asset_id) references public.meta_assets(organization_id,id) on delete set null(meta_social_asset_id);
alter table public.channel_sessions drop constraint if exists channel_sessions_meta_social_connection_fk;
alter table public.channel_sessions add constraint channel_sessions_meta_social_connection_fk
 foreign key(organization_id,meta_social_connection_id) references public.meta_connections(organization_id,id) on delete set null(meta_social_connection_id);
create or replace function public.fn_meta_messaging_authorization_changed() returns trigger
 language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='meta_connections' then
   if tg_op='DELETE' or new.status not in ('healthy','selection_pending') then
     update public.channel_sessions set status='STOPPED',status_reason='authorization_revoked',
       metadata=metadata||jsonb_build_object('messaging_error','authorization_revoked')
       where organization_id=old.organization_id and provider='meta_social' and meta_social_connection_id=old.id;
   end if;
 else
   if tg_op='DELETE' or not new.selected or new.status<>'healthy' then
     update public.channel_sessions set status='STOPPED',status_reason='authorization_revoked',
       metadata=metadata||jsonb_build_object('messaging_error','authorization_revoked')
       where organization_id=old.organization_id and provider='meta_social'
         and meta_social_connection_id=old.connection_id and meta_social_asset_id=old.asset_id;
   end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke execute on function public.fn_meta_messaging_authorization_changed() from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_authorization_changed() to service_role;
drop trigger if exists meta_connections_messaging_revoked on public.meta_connections;
create trigger meta_connections_messaging_revoked after update of status or delete on public.meta_connections
 for each row execute function public.fn_meta_messaging_authorization_changed();
drop trigger if exists meta_asset_grants_messaging_revoked on public.meta_asset_grants;
create trigger meta_asset_grants_messaging_revoked after update of selected,status or delete on public.meta_asset_grants
 for each row execute function public.fn_meta_messaging_authorization_changed();
notify pgrst,'reload schema';
-- The privacy worker deletes revoked connections. Redact their native Inbox derivatives
-- before nulling provenance; CRM identity/activities remain independent, including merges.
create or replace function public.fn_meta_messaging_privacy_cleanup() returns trigger
 language plpgsql security definer set search_path=public,pg_temp as $$
begin
 delete from public.event_log e where e.organization_id=old.organization_id and (
   e.payload->>'channel_session_id' in (select s.id::text from public.channel_sessions s where s.organization_id=old.organization_id and s.provider='meta_social' and s.meta_social_connection_id=old.id)
   or e.payload->>'message_id' in (select m.id::text from public.messages m join public.channel_sessions s on s.organization_id=m.organization_id and s.id=m.channel_session_id where s.organization_id=old.organization_id and s.provider='meta_social' and s.meta_social_connection_id=old.id));
 update public.messages m set body='[mensagem anonimizada]',external_id=null,media_url=null,metadata='{}'::jsonb
   where m.organization_id=old.organization_id and m.channel_session_id in
     (select s.id from public.channel_sessions s where s.organization_id=old.organization_id
       and s.provider='meta_social' and s.meta_social_connection_id=old.id);
 update public.conversations c set provider_conversation_id=null,last_message_preview=null,metadata='{}'::jsonb
   where c.organization_id=old.organization_id and c.channel_session_id in
     (select s.id from public.channel_sessions s where s.organization_id=old.organization_id
       and s.provider='meta_social' and s.meta_social_connection_id=old.id);
 -- Manual merges leave losing contact tombstones with no conversations. Their native
 -- scoped identity still belongs to this connection and must be stripped as well.
 update public.contacts contact set social_identity=null
   where contact.organization_id=old.organization_id and exists(
     select 1 from public.channel_sessions s where s.organization_id=old.organization_id
       and s.provider='meta_social' and s.meta_social_connection_id=old.id
       and contact.social_identity like (s.metadata->>'social_platform')||':'||s.meta_social_external_id||':%'
       and not exists(select 1 from public.channel_sessions other_s
         where other_s.organization_id=s.organization_id and other_s.provider='meta_social'
           and other_s.meta_social_external_id=s.meta_social_external_id
           and other_s.meta_social_connection_id is distinct from old.id and other_s.archived_at is null)
       and not exists(select 1 from public.channel_sessions legacy_s
         where legacy_s.organization_id=s.organization_id and legacy_s.provider='zernio_social'
           and legacy_s.zernio_account_id=s.meta_social_external_id
           and legacy_s.metadata->>'social_platform'=s.metadata->>'social_platform' and legacy_s.archived_at is null));
 update public.channel_sessions set status='STOPPED',archived_at=coalesce(archived_at,now()),
   meta_social_external_id=null,meta_social_asset_id=null,display_name=null,metadata='{}'::jsonb
   where organization_id=old.organization_id and provider='meta_social' and meta_social_connection_id=old.id;
 return old;
end;$$;
revoke execute on function public.fn_meta_messaging_privacy_cleanup() from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_privacy_cleanup() to service_role;
drop trigger if exists meta_connections_messaging_privacy_cleanup on public.meta_connections;
create trigger meta_connections_messaging_privacy_cleanup before delete on public.meta_connections
 for each row execute function public.fn_meta_messaging_privacy_cleanup();
-- The tenant admin policy predates native OAuth. It must not let a browser invent
-- signed-entry provenance or claim WORKING without a service-side subscription.
create or replace function public.fn_meta_messaging_session_guard() returns trigger
 language plpgsql set search_path=public,pg_temp as $$
begin
 if (tg_op<>'INSERT' and old.provider='meta_social') or (tg_op<>'DELETE' and new.provider='meta_social') then
   if current_user not in ('service_role','postgres','supabase_admin') then
     raise exception 'native_messaging_service_only' using errcode='42501';
   end if;
   if tg_op<>'DELETE' and new.provider='meta_social' and new.archived_at is null then
     if not exists(select 1 from public.meta_assets a join public.meta_connections c
       on c.organization_id=a.organization_id and c.id=new.meta_social_connection_id
       where a.organization_id=new.organization_id and a.id=new.meta_social_asset_id
         and a.external_id=new.meta_social_external_id
         and ((a.kind='instagram' and new.metadata->>'social_platform'='instagram')
           or (a.kind='page' and new.metadata->>'social_platform'='facebook'))) then
       raise exception 'native_messaging_provenance_invalid' using errcode='23514';
     end if;
     if new.status='WORKING' and not exists(select 1 from public.meta_asset_grants g join public.meta_connections c
       on c.organization_id=g.organization_id and c.id=g.connection_id
       where g.organization_id=new.organization_id and g.asset_id=new.meta_social_asset_id
         and g.connection_id=new.meta_social_connection_id and g.selected and g.status='healthy' and c.status='healthy') then
       raise exception 'native_messaging_grant_revoked' using errcode='23514';
     end if;
   end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke execute on function public.fn_meta_messaging_session_guard() from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_session_guard() to service_role;
drop trigger if exists channel_sessions_meta_messaging_guard on public.channel_sessions;
create trigger channel_sessions_meta_messaging_guard before insert or update or delete on public.channel_sessions
 for each row execute function public.fn_meta_messaging_session_guard();
create or replace function public.fn_meta_messaging_resolve_entry(p_external_id text,p_platform text)
 returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
 if p_external_id !~ '^[0-9]{1,100}$' or p_platform not in ('instagram','facebook') then
   raise exception 'invalid_messaging_entry' using errcode='22023';
 end if;
 select coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) into result from
   (select s.id,s.organization_id,s.meta_social_asset_id,s.meta_social_connection_id,s.meta_social_external_id,s.status,s.updated_at,s.metadata
    from public.channel_sessions s join public.meta_assets a on a.organization_id=s.organization_id and a.id=s.meta_social_asset_id
    join public.meta_connections c on c.organization_id=s.organization_id and c.id=s.meta_social_connection_id
    join public.meta_asset_grants g on g.organization_id=s.organization_id and g.asset_id=a.id and g.connection_id=c.id
    where s.provider='meta_social' and s.archived_at is null and s.status='WORKING'
      and s.meta_social_external_id=p_external_id and a.external_id=p_external_id
      and s.metadata->>'social_platform'=p_platform
      and ((p_platform='instagram' and a.kind='instagram') or (p_platform='facebook' and a.kind='page'))
      and c.status='healthy' and g.selected and g.status='healthy' limit 2) s;
 if jsonb_array_length(result)>1 then raise exception 'messaging_entry_ambiguous' using errcode='PT409';end if;
 return result;
end;$$;
revoke execute on function public.fn_meta_messaging_resolve_entry(text,text) from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_resolve_entry(text,text) to service_role;
-- Private ingress content is visible only through the conversation ACL after consumption.
drop policy if exists event_log_native_messaging_private on public.event_log;
create policy event_log_native_messaging_private on public.event_log as restrictive for select to authenticated
 using(event_type<>'channel.messaging_received');
-- emit_event/fn_log_event are authenticated definers: retain the caller's auth.uid
-- so they cannot forge a signed native ingress by bypassing table RLS.
create or replace function public.fn_meta_messaging_event_guard() returns trigger
 language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if auth.uid() is not null and ((tg_op<>'INSERT' and old.event_type='channel.messaging_received')
   or (tg_op<>'DELETE' and new.event_type='channel.messaging_received')) then
   raise exception 'native_messaging_event_service_only' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end;$$;
revoke execute on function public.fn_meta_messaging_event_guard() from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_event_guard() to service_role;
drop trigger if exists event_log_meta_messaging_guard on public.event_log;
create trigger event_log_meta_messaging_guard before insert or update or delete on public.event_log
 for each row execute function public.fn_meta_messaging_event_guard();
comment on function public.fn_meta_messaging_event_guard() is 'meta-messaging-0418-private-event';

-- Fast ingress persists into the existing event_log; acknowledgement precedes no write.
create or replace function public.fn_meta_messaging_accept(p_envelope jsonb) returns integer
 language plpgsql security definer set search_path=public,pg_temp as $$
declare entry jsonb; route jsonb; platform text; event_id uuid; queued integer:=0; inserted integer;
begin
 platform:=case p_envelope->>'object' when 'instagram' then 'instagram' when 'page' then 'facebook' end;
 if platform is null or jsonb_typeof(p_envelope->'entry')<>'array' or jsonb_array_length(p_envelope->'entry')>100 then
   raise exception 'invalid_messaging_envelope' using errcode='22023';
 end if;
 for entry in select value from jsonb_array_elements(p_envelope->'entry') loop
   route:=public.fn_meta_messaging_resolve_entry(entry->>'id',platform)->0;
   if route is not null then
     -- Connection deletion must wait for durable acceptance; cleanup then sees this job.
     perform 1 from public.meta_connections where organization_id=(route->>'organization_id')::uuid
       and id=(route->>'meta_social_connection_id')::uuid and status='healthy' for share;
     if not found then continue;end if;
     perform 1 from public.channel_sessions where organization_id=(route->>'organization_id')::uuid
       and id=(route->>'id')::uuid and status='WORKING' and archived_at is null for share;
     if not found then continue;end if;
     route:=public.fn_meta_messaging_resolve_entry(entry->>'id',platform)->0;
     if route is null then continue;end if;
     event_id:=md5((route->>'organization_id')||':'||(route->>'meta_social_connection_id')||':'||platform||':'||entry::text)::uuid;
     insert into public.event_log(id,organization_id,event_type,entity_kind,entity_id,payload,metadata)
       values(event_id,(route->>'organization_id')::uuid,'channel.messaging_received','channel_session',(route->>'id')::uuid,
       jsonb_build_object('channel_session_id',route->>'id','connection_id',route->>'meta_social_connection_id','platform',platform,'entry',entry),
       jsonb_build_object('source','native_messaging','connection_id',route->>'meta_social_connection_id'))
       on conflict(id) do nothing;
     get diagnostics inserted=row_count;queued:=queued+inserted;
   end if;
 end loop;
 return queued;
end;$$;
revoke execute on function public.fn_meta_messaging_accept(jsonb) from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_accept(jsonb) to service_role;

-- One transaction holds the channel lock throughout Inbox insertion. A privacy/revoke
-- transition waits for it, so neither a stale worker nor a crash resurrects cleared data.
create or replace function public.fn_meta_messaging_ingest(p_event_id uuid) returns boolean
 language plpgsql security definer set search_path=public,pg_temp as $$
declare job public.event_log%rowtype; session public.channel_sessions%rowtype; asset public.meta_assets%rowtype;
  event jsonb; entry jsonb; platform text; echo boolean; participant text; identity text;
  contact_id uuid; conversation_id uuid; message_id uuid; external text; v_direction text; body text; at_time timestamptz; mid jsonb;
begin
 set constraints messages_org_external_id_unique immediate;
 select * into job from public.event_log where id=p_event_id and event_type='channel.messaging_received' for update;
 if not found then return false;end if;
 select * into session from public.channel_sessions
   where organization_id=job.organization_id and id=(job.payload->>'channel_session_id')::uuid
     and provider='meta_social' and status='WORKING' and archived_at is null for update;
 if not found or session.meta_social_connection_id is distinct from (job.payload->>'connection_id')::uuid then return false;end if;
 platform:=job.payload->>'platform';entry:=job.payload->'entry';
 select * into asset from public.meta_assets where organization_id=session.organization_id and id=session.meta_social_asset_id;
 if not found or asset.external_id<>entry->>'id' or session.meta_social_external_id<>asset.external_id
   or session.metadata->>'social_platform'<>platform then return false;end if;
 if not exists(select 1 from public.meta_asset_grants g join public.meta_connections c on c.organization_id=g.organization_id and c.id=g.connection_id
   join public.platform_meta_app app on app.id=1 and app.app_id=c.app_id
   left join public.meta_assets parent on parent.organization_id=asset.organization_id and parent.id=asset.parent_page_id
   where g.organization_id=session.organization_id and g.asset_id=asset.id and g.connection_id=session.meta_social_connection_id
     and g.selected and g.status='healthy' and c.status='healthy' and app.native_enabled
     and (c.token_expires_at is null or c.token_expires_at>now()) and (c.data_access_expires_at is null or c.data_access_expires_at>now())
     and (g.tasks && array['MESSAGING','MODERATE','MANAGE','PROFILE_PLUS_MESSAGING'])
     and ((platform='instagram' and app.instagram_enabled and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'instagram_basic',asset.external_id,parent.external_id)
         and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'instagram_manage_messages',asset.external_id,parent.external_id)
         and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'pages_manage_metadata',asset.external_id,parent.external_id))
       or (platform='facebook' and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'pages_messaging',asset.external_id,null)
         and public.fn_meta_scope_granted(c.scopes,g.permissions,c.granular_scopes,'pages_manage_metadata',asset.external_id,null)))) then return false;end if;
 for event in select value from jsonb_array_elements(entry->'messaging') loop
   echo:=coalesce((event->'message'->>'is_echo')::boolean,false);
   if (case when echo then event->'sender'->>'id' else event->'recipient'->>'id' end)<>asset.external_id then continue;end if;
   participant:=case when echo then event->'recipient'->>'id' else event->'sender'->>'id' end;
   if participant !~ '^[0-9]{1,100}$' or participant=asset.external_id then continue;end if;
   at_time:=to_timestamp((event->>'timestamp')::numeric/1000);
   if at_time>now()+interval '1 minute' then continue;end if;
   if coalesce((event->'message'->>'is_deleted')::boolean,false) then
     update public.messages set revoked_at=at_time,body=null where organization_id=session.organization_id
       and channel_session_id=session.id and external_id='meta:'||asset.external_id||':'||(event->'message'->>'mid');
     continue;
   end if;
   if event->'message'->>'mid' is not null then
     external:='meta:'||asset.external_id||':'||(event->'message'->>'mid');
     if exists(select 1 from public.messages where organization_id=session.organization_id and external_id=external) then continue;end if;
     -- Thread identity survives manual contact merges; never recreate the losing contact.
     select c.id,c.contact_id into conversation_id,contact_id from public.conversations c
       where c.organization_id=session.organization_id and c.channel_session_id=session.id and c.provider_conversation_id=participant;
     if conversation_id is not null and exists(select 1 from public.conversations c
       where c.organization_id=session.organization_id and c.channel_session_id=session.id
         and c.provider_conversation_id=participant and c.id<>conversation_id) then
       raise exception 'native_messaging_thread_ambiguous' using errcode='PT409';
     end if;
     if conversation_id is null then
       identity:=platform||':'||asset.external_id||':'||participant;
       select c.id into contact_id from public.contacts c where c.organization_id=session.organization_id and c.social_identity=identity and c.is_merged_into is null;
       if contact_id is null then
         insert into public.contacts(organization_id,social_identity,source)
           values(session.organization_id,identity,'social') on conflict(organization_id,social_identity)
           where social_identity is not null and is_merged_into is null do nothing returning id into contact_id;
         if contact_id is null then select c.id into contact_id from public.contacts c where c.organization_id=session.organization_id and c.social_identity=identity and c.is_merged_into is null;end if;
       end if;
       conversation_id:=public.fn_upsert_wa_conversation(session.organization_id,contact_id,session.id);
     end if;
     update public.conversations set channel=platform,provider_conversation_id=participant
       where organization_id=session.organization_id and id=conversation_id;
     v_direction:=case when echo then 'outbound' else 'inbound' end;
     body:=coalesce(event->'message'->>'text',case when jsonb_array_length(coalesce(event->'message'->'attachments','[]'::jsonb))>0 then '[Anexo recebido nesta rede]' end);
     message_id:=null;
     begin
     insert into public.messages(organization_id,contact_id,conversation_id,channel_session_id,direction,status,type,body,external_id,sent_at,sent_via)
       values(session.organization_id,contact_id,conversation_id,session.id,v_direction,case when echo then 'sent' else 'delivered' end,'text',body,external,at_time,'external_device')
       returning id into message_id;
     exception when unique_violation then message_id:=null;end;
     if message_id is not null then perform public.fn_mark_conversation_message(conversation_id,v_direction,left(coalesce(body,''),200),at_time);end if;
   elsif event->'delivery'->'mids' is not null then
     for mid in select value from jsonb_array_elements(event->'delivery'->'mids') loop
       update public.messages set status='delivered' where organization_id=session.organization_id and channel_session_id=session.id
         and direction='outbound' and external_id='meta:'||asset.external_id||':'||(mid#>>'{}') and status in ('sent','sending');
     end loop;
   elsif event->'read'->>'mid' is not null and platform='instagram' then
     update public.messages set status='read' where organization_id=session.organization_id and channel_session_id=session.id and direction='outbound'
       and external_id='meta:'||asset.external_id||':'||(event->'read'->>'mid') and status in ('sent','delivered');
   elsif event->'read'->>'watermark' is not null and platform='facebook' then
     update public.messages m set status='read' where m.organization_id=session.organization_id and m.channel_session_id=session.id and m.direction='outbound'
       and m.status in ('sent','delivered') and m.sent_at<=to_timestamp((event->'read'->>'watermark')::numeric/1000)
       and m.conversation_id in (select c.id from public.conversations c where c.organization_id=session.organization_id and c.channel_session_id=session.id and c.provider_conversation_id=participant);
   end if;
 end loop;
 return true;
end;$$;
revoke execute on function public.fn_meta_messaging_ingest(uuid) from public,anon,authenticated;
grant execute on function public.fn_meta_messaging_ingest(uuid) to service_role;

-- Suppress automatic generic message consumers for the first, manual-only native release.
create or replace function public.fn_emit_message_event() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_event text;
begin
 if exists(select 1 from public.channel_sessions s where s.organization_id=new.organization_id and s.id=new.channel_session_id and s.provider='meta_social') then return new;end if;
 if new.direction='inbound' then v_event:='message.received';
 else v_event:=case new.status when 'sending' then 'message.sending' when 'sent' then 'message.sent' when 'failed' then 'message.failed' else 'message.outbound' end;end if;
 perform public.fn_log_event(new.organization_id,v_event,jsonb_build_object(
   'message_id',new.id,'conversation_id',new.conversation_id,'contact_id',new.contact_id,'direction',new.direction,
   'type',new.type,'status',new.status,'external_id',new.external_id,'channel_session_id',new.channel_session_id,'body_preview',left(new.body,280)));
 return new;
end;$$;
revoke execute on function public.fn_emit_message_event() from public,anon,authenticated;
grant execute on function public.fn_emit_message_event() to service_role;
notify pgrst,'reload schema';
comment on function public.fn_meta_messaging_authorization_changed() is 'meta-messaging-0418-authorization';
comment on function public.fn_meta_messaging_privacy_cleanup() is 'meta-messaging-0418-privacy';
comment on function public.fn_meta_messaging_session_guard() is 'meta-messaging-0418-provenance';
comment on function public.fn_meta_messaging_resolve_entry(text,text) is 'meta-messaging-0418-routing';
comment on function public.fn_meta_messaging_accept(jsonb) is 'meta-messaging-0418-ingress';
comment on function public.fn_meta_messaging_ingest(uuid) is 'meta-messaging-0418-manual-inbox';
