-- 0418 deploy gate. Missing may be installed; partial/incompatible must never start new app.
with columns_contract as (
 select count(a.attname) installed,
   coalesce(bool_and(a.atttypid=case when x.name='meta_social_external_id' then 'text'::regtype else 'uuid'::regtype end and not a.attnotnull),false) valid
 from (values('meta_social_asset_id'),('meta_social_connection_id'),('meta_social_external_id')) x(name)
 left join pg_attribute a on a.attrelid=to_regclass('public.channel_sessions') and a.attname=x.name and a.attnum>0 and not a.attisdropped
), function_contract as (
 select count(p.oid) installed,coalesce(bool_and(p.prorettype=x.result::regtype and p.prosecdef=x.definer
   and array_to_string(p.proconfig,',') like '%search_path=public, pg_temp%'
   and obj_description(p.oid,'pg_proc') like 'meta-messaging-0418-%'
   and has_function_privilege('service_role',p.oid,'EXECUTE')
   and not has_function_privilege('anon',p.oid,'EXECUTE')
   and not has_function_privilege('authenticated',p.oid,'EXECUTE')
   and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')),false) valid
 from (values
   ('public.fn_meta_messaging_authorization_changed()','trigger',true),
   ('public.fn_meta_messaging_privacy_cleanup()','trigger',true),
   ('public.fn_meta_messaging_session_guard()','trigger',false),
   ('public.fn_meta_messaging_event_guard()','trigger',false),
   ('public.fn_meta_messaging_resolve_entry(text,text)','jsonb',true),
   ('public.fn_meta_messaging_accept(jsonb)','integer',true),
   ('public.fn_meta_messaging_ingest(uuid)','boolean',true)
 ) x(signature,result,definer) left join pg_proc p on p.oid=to_regprocedure(x.signature)
), trigger_contract as (
 select count(t.oid) installed,coalesce(bool_and(t.tgenabled='O' and t.tgfoid=to_regprocedure(x.signature) and not t.tgisinternal),false) valid
 from (values
  ('event_log','event_log_meta_messaging_guard','public.fn_meta_messaging_event_guard()'),
  ('channel_sessions','channel_sessions_meta_messaging_guard','public.fn_meta_messaging_session_guard()'),
  ('meta_connections','meta_connections_messaging_privacy_cleanup','public.fn_meta_messaging_privacy_cleanup()'),
  ('meta_connections','meta_connections_messaging_revoked','public.fn_meta_messaging_authorization_changed()'),
  ('meta_asset_grants','meta_asset_grants_messaging_revoked','public.fn_meta_messaging_authorization_changed()')
 ) x(tablename,name,signature) left join pg_trigger t on t.tgrelid=to_regclass('public.'||x.tablename) and t.tgname=x.name
), index_contract as (
 select count(i.indexrelid) installed,coalesce(bool_and(i.indisunique and i.indisvalid and pg_get_expr(i.indpred,i.indrelid) like '%archived_at IS NULL%'),false) valid
 from (values('channel_sessions_meta_social_external_active_unique'),('channel_sessions_meta_social_asset_active_unique')) x(name)
 left join pg_index i on i.indexrelid=to_regclass('public.'||x.name)
), fk_contract as (
 select count(c.oid) installed,coalesce(bool_and(c.contype='f' and c.convalidated and c.confdeltype='n'
   and c.conkey=array[(select attnum from pg_attribute where attrelid=to_regclass('public.channel_sessions') and attname='organization_id'),
     (select attnum from pg_attribute where attrelid=to_regclass('public.channel_sessions') and attname=x.columnname)]::smallint[]
   and c.confrelid=to_regclass('public.'||x.target)),false) valid
 from (values('channel_sessions_meta_social_asset_fk','meta_social_asset_id','meta_assets'),
   ('channel_sessions_meta_social_connection_fk','meta_social_connection_id','meta_connections')) x(name,columnname,target)
 left join pg_constraint c on c.conrelid=to_regclass('public.channel_sessions') and c.conname=x.name
), checks as (
 select coalesce((select pg_get_constraintdef(oid) like '%meta_social%' from pg_constraint where conrelid=to_regclass('public.channel_sessions') and conname='channel_sessions_provider_check'),false)
   and coalesce((select pg_get_constraintdef(oid) like '%meta_social_external_id%' from pg_constraint where conrelid=to_regclass('public.channel_sessions') and conname='channel_sessions_provider_ref_check'),false) valid
), manual_gate as (
 select coalesce((select md5(prosrc)='d2984c63e6fbc7926459d9584369df4d' from pg_proc where oid=to_regprocedure('public.fn_emit_message_event()')),false) valid
), known_core as (
 select coalesce((select md5(prosrc) in ('1277798a1587cfd0a46df1be2f6511ac','d2984c63e6fbc7926459d9584369df4d')
   from pg_proc where oid=to_regprocedure('public.fn_emit_message_event()')),false) valid
), private_queue as (
 select exists(select 1 from pg_policy where polrelid=to_regclass('public.event_log') and polname='event_log_native_messaging_private') installed, coalesce((select not polpermissive and polcmd='r'
   and polroles=array[(select oid from pg_roles where rolname='authenticated')]
   and regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g')='event_type<>''channel.messaging_received''::text'
   from pg_policy where polrelid=to_regclass('public.event_log') and polname='event_log_native_messaging_private'),false) valid
), dependencies as (
 select to_regclass('public.meta_connections') is not null and to_regclass('public.meta_asset_grants') is not null
   and to_regclass('public.meta_privacy_requests') is not null and to_regclass('public.event_log') is not null
   and to_regprocedure('public.fn_meta_scope_granted(text[],text[],jsonb,text,text,text)') is not null
   and to_regprocedure('public.fn_upsert_wa_conversation(uuid,uuid,uuid)') is not null
   and to_regprocedure('public.fn_mark_conversation_message(uuid,text,text,timestamp with time zone)') is not null ready
)
select case
 when not d.ready then 'dependencies_missing'
 when not b.valid then 'incompatible'
 when c.installed=0 and f.installed=0 and t.installed=0 and i.installed=0 and k.installed=0 and not q.installed then 'missing'
 when c.installed<>3 or f.installed<>7 or t.installed<>5 or i.installed<>2 or k.installed<>2 then 'partial'
 when c.valid and f.valid and t.valid and i.valid and k.valid and h.valid and m.valid and q.valid then 'ready'
 else 'incompatible' end
from columns_contract c cross join function_contract f cross join trigger_contract t cross join index_contract i cross join fk_contract k cross join checks h cross join manual_gate m cross join dependencies d cross join known_core b cross join private_queue q;
