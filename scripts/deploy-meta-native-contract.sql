-- 0416 contract: preserve compatible forward fixes; reject partial installation.
with tables(name) as (values
  ('meta_oauth_attempts'),('meta_connections'),('meta_assets'),
  ('meta_asset_grants'),('meta_campaign_drafts'),('meta_operations')
), table_contract as (
  select count(c.oid) installed, coalesce(bool_and(c.relkind='r' and c.relrowsecurity
    and has_table_privilege('service_role',c.oid,'SELECT')
    and has_table_privilege('service_role',c.oid,'INSERT')
    and has_table_privilege('service_role',c.oid,'UPDATE')
    and has_table_privilege('service_role',c.oid,'DELETE')
    and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    and not has_any_column_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
      where acl.grantee=0)),false) valid
  from tables t left join pg_class c on c.oid=to_regclass('public.'||t.name)
), functions(signature,result,service_execute) as (values
    ('public.fn_meta_app_revision()','trigger',null),
    ('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)','bigint',true),
    ('public.fn_meta_draft_revision()','trigger',null),
    ('public.fn_meta_immutable_identity()','trigger',null),
    ('public.fn_meta_require_actor(uuid,uuid,text)','void',true),
    ('public.fn_meta_oauth_claim(text,text)','jsonb',true),
    ('public.fn_meta_oauth_store_result(uuid,uuid,text,bytea)','boolean',true),
    ('public.fn_meta_inventory_apply(uuid,uuid,jsonb,boolean)','void',true),
    ('public.fn_meta_refresh_inventory(uuid,uuid,bigint,jsonb,text[],jsonb,timestamptz,timestamptz)','boolean',true),
    ('public.fn_meta_oauth_finalize(uuid,uuid,text,text)','jsonb',true),
    ('public.fn_meta_select_assets(uuid,uuid,uuid,uuid[])','jsonb',true),
    ('public.fn_meta_disconnect(uuid,uuid,uuid)','jsonb',true),
    ('public.fn_meta_expire_oauth(integer)','integer',true),
    ('public.fn_meta_scope_granted(text[],text[],jsonb,text,text,text)','boolean',true),
    ('public.fn_meta_operation_authorized(uuid)','boolean',true),
    ('public.fn_meta_operation_reserve(uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb)','jsonb',true),
    ('public.fn_meta_operation_claim(uuid,text,integer)','jsonb',true),
    ('public.fn_meta_operation_begin_dispatch(uuid,uuid,text,bigint)','boolean',true),
    ('public.fn_meta_operation_heartbeat(uuid,uuid,text,bigint,integer)','boolean',true),
    ('public.fn_meta_operation_checkpoint(uuid,uuid,text,bigint,text,text,jsonb,jsonb,text,text,timestamptz)','boolean',true)
), function_contract as (
  select count(p.oid) installed, coalesce(bool_and(p.prokind='f' and not p.prosecdef
    and p.prorettype=to_regtype(f.result)
    and coalesce(p.proconfig,'{}'::text[]) @> array['search_path=""']
    and (f.service_execute is null or has_function_privilege('service_role',p.oid,'execute')=f.service_execute)
    and not has_function_privilege('anon',p.oid,'execute')
    and not has_function_privilege('authenticated',p.oid,'execute')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where acl.grantee=0 and acl.privilege_type='EXECUTE')),false) valid
  from functions f left join pg_proc p on p.oid=to_regprocedure(f.signature)
), columns(table_name,name,type_name,not_null,default_expression) as (values
  ('platform_meta_app','app_id','text',false,null),
  ('platform_meta_app','config_id','text',false,null),
  ('platform_meta_app','config_revision','bigint',true,'1'),
  ('platform_meta_app','native_enabled','boolean',true,'false'),
  ('platform_meta_app','instagram_enabled','boolean',true,'false'),
  ('platform_meta_app','ads_enabled','boolean',true,'false'),
  ('instagram_publications','provider','text',true,'''zernio''::text'),
  ('instagram_publications','meta_asset_id','uuid',false,null),
  ('instagram_publications','operation_id','uuid',false,null),
  ('instagram_publications','requested_by','uuid',false,null),
  ('meta_asset_grants','id','uuid',true,'gen_random_uuid()'),
  ('meta_asset_grants','organization_id','uuid',true,NULL),
  ('meta_asset_grants','connection_id','uuid',true,NULL),
  ('meta_asset_grants','asset_id','uuid',true,NULL),
  ('meta_asset_grants','tasks','text[]',true,'''{}''::text[]'),
  ('meta_asset_grants','permissions','text[]',true,'''{}''::text[]'),
  ('meta_asset_grants','page_access_token_encrypted','bytea',false,NULL),
  ('meta_asset_grants','selected','boolean',true,'false'),
  ('meta_asset_grants','status','text',true,'''healthy''::text'),
  ('meta_asset_grants','observed_at','timestamp with time zone',true,'now()'),
  ('meta_asset_grants','created_at','timestamp with time zone',true,'now()'),
  ('meta_asset_grants','updated_at','timestamp with time zone',true,'now()'),
  ('meta_assets','id','uuid',true,'gen_random_uuid()'),
  ('meta_assets','organization_id','uuid',true,NULL),
  ('meta_assets','kind','text',true,NULL),
  ('meta_assets','external_id','text',true,NULL),
  ('meta_assets','name','text',true,'''''::text'),
  ('meta_assets','parent_page_id','uuid',false,NULL),
  ('meta_assets','currency','text',false,NULL),
  ('meta_assets','timezone','text',false,NULL),
  ('meta_assets','metadata','jsonb',true,'''{}''::jsonb'),
  ('meta_assets','created_at','timestamp with time zone',true,'now()'),
  ('meta_assets','updated_at','timestamp with time zone',true,'now()'),
  ('meta_campaign_drafts','id','uuid',true,'gen_random_uuid()'),
  ('meta_campaign_drafts','organization_id','uuid',true,NULL),
  ('meta_campaign_drafts','created_by','uuid',true,NULL),
  ('meta_campaign_drafts','ad_account_asset_id','uuid',true,NULL),
  ('meta_campaign_drafts','page_asset_id','uuid',false,NULL),
  ('meta_campaign_drafts','instagram_asset_id','uuid',false,NULL),
  ('meta_campaign_drafts','name','text',true,NULL),
  ('meta_campaign_drafts','objective','text',true,NULL),
  ('meta_campaign_drafts','destination_url','text',false,NULL),
  ('meta_campaign_drafts','daily_budget_cents','bigint',true,NULL),
  ('meta_campaign_drafts','currency','text',true,NULL),
  ('meta_campaign_drafts','starts_at','timestamp with time zone',false,NULL),
  ('meta_campaign_drafts','ends_at','timestamp with time zone',false,NULL),
  ('meta_campaign_drafts','targeting','jsonb',true,'''{}''::jsonb'),
  ('meta_campaign_drafts','creative','jsonb',true,'''{}''::jsonb'),
  ('meta_campaign_drafts','status','text',true,'''draft''::text'),
  ('meta_campaign_drafts','revision','bigint',true,'1'),
  ('meta_campaign_drafts','approved_revision','bigint',false,NULL),
  ('meta_campaign_drafts','approved_hash','text',false,NULL),
  ('meta_campaign_drafts','created_at','timestamp with time zone',true,'now()'),
  ('meta_campaign_drafts','updated_at','timestamp with time zone',true,'now()'),
  ('meta_connections','id','uuid',true,'gen_random_uuid()'),
  ('meta_connections','organization_id','uuid',true,NULL),
  ('meta_connections','app_id','text',true,NULL),
  ('meta_connections','local_actor_id','uuid',true,NULL),
  ('meta_connections','remote_actor_id','text',true,NULL),
  ('meta_connections','actor_name','text',true,'''''::text'),
  ('meta_connections','oauth_access_token_encrypted','bytea',false,NULL),
  ('meta_connections','token_type','text',true,'''user''::text'),
  ('meta_connections','token_expires_at','timestamp with time zone',false,NULL),
  ('meta_connections','data_access_expires_at','timestamp with time zone',false,NULL),
  ('meta_connections','scopes','text[]',true,'''{}''::text[]'),
  ('meta_connections','granular_scopes','jsonb',true,'''[]''::jsonb'),
  ('meta_connections','version','bigint',true,'1'),
  ('meta_connections','status','text',true,'''selection_pending''::text'),
  ('meta_connections','last_validated_at','timestamp with time zone',true,'now()'),
  ('meta_connections','revoked_at','timestamp with time zone',false,NULL),
  ('meta_connections','created_at','timestamp with time zone',true,'now()'),
  ('meta_connections','updated_at','timestamp with time zone',true,'now()'),
  ('meta_oauth_attempts','id','uuid',true,'gen_random_uuid()'),
  ('meta_oauth_attempts','organization_id','uuid',true,NULL),
  ('meta_oauth_attempts','actor_id','uuid',true,NULL),
  ('meta_oauth_attempts','auth_session_id','text',true,NULL),
  ('meta_oauth_attempts','app_id','text',true,NULL),
  ('meta_oauth_attempts','config_id','text',true,NULL),
  ('meta_oauth_attempts','config_revision','bigint',true,NULL),
  ('meta_oauth_attempts','state_hash','text',true,NULL),
  ('meta_oauth_attempts','cookie_hash','text',true,NULL),
  ('meta_oauth_attempts','ticket_hash','text',false,NULL),
  ('meta_oauth_attempts','status','text',true,'''pending''::text'),
  ('meta_oauth_attempts','callback_claim_id','uuid',false,NULL),
  ('meta_oauth_attempts','callback_claimed_at','timestamp with time zone',false,NULL),
  ('meta_oauth_attempts','pending_result_encrypted','bytea',false,NULL),
  ('meta_oauth_attempts','failure_code','text',false,NULL),
  ('meta_oauth_attempts','expires_at','timestamp with time zone',true,NULL),
  ('meta_oauth_attempts','finalized_at','timestamp with time zone',false,NULL),
  ('meta_oauth_attempts','created_at','timestamp with time zone',true,'now()'),
  ('meta_oauth_attempts','updated_at','timestamp with time zone',true,'now()'),
  ('meta_operations','id','uuid',true,'gen_random_uuid()'),
  ('meta_operations','organization_id','uuid',true,NULL),
  ('meta_operations','actor_id','uuid',true,NULL),
  ('meta_operations','connection_id','uuid',true,NULL),
  ('meta_operations','asset_id','uuid',true,NULL),
  ('meta_operations','grant_id','uuid',true,NULL),
  ('meta_operations','campaign_draft_id','uuid',false,NULL),
  ('meta_operations','authorization_version','bigint',true,NULL),
  ('meta_operations','kind','text',true,NULL),
  ('meta_operations','operation_key','text',true,NULL),
  ('meta_operations','request_hash','text',true,NULL),
  ('meta_operations','request_payload','jsonb',true,NULL),
  ('meta_operations','status','text',true,'''queued''::text'),
  ('meta_operations','stage','text',true,'''reserved''::text'),
  ('meta_operations','external_ids','jsonb',true,'''{}''::jsonb'),
  ('meta_operations','receipt','jsonb',false,NULL),
  ('meta_operations','error_code','text',false,NULL),
  ('meta_operations','error_message','text',false,NULL),
  ('meta_operations','lease_owner','text',false,NULL),
  ('meta_operations','lease_until','timestamp with time zone',false,NULL),
  ('meta_operations','fence','bigint',true,'0'),
  ('meta_operations','external_dispatch_started_at','timestamp with time zone',false,NULL),
  ('meta_operations','retry_at','timestamp with time zone',true,'now()'),
  ('meta_operations','completed_at','timestamp with time zone',false,NULL),
  ('meta_operations','created_at','timestamp with time zone',true,'now()'),
  ('meta_operations','updated_at','timestamp with time zone',true,'now()')
), column_contract as (
  select count(a.attname) installed,count(*) expected, coalesce(bool_and(a.atttypid=to_regtype(c.type_name)
    and a.attnotnull=c.not_null and a.attgenerated='' and a.attidentity=''
    and pg_get_expr(d.adbin,d.adrelid) is not distinct from c.default_expression),false) valid
  from columns c left join pg_attribute a
    on a.attrelid=to_regclass('public.'||c.table_name) and a.attname=c.name and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
), triggers(table_name,name,function_signature) as (
  values
    ('platform_meta_app','trg_meta_app_revision','public.fn_meta_app_revision()'),
    ('meta_campaign_drafts','trg_meta_draft_revision','public.fn_meta_draft_revision()'),
    ('meta_connections','trg_meta_connection_identity','public.fn_meta_immutable_identity()'),
    ('meta_operations','trg_meta_operation_intent','public.fn_meta_immutable_identity()'),
    ('meta_oauth_attempts','trg_meta_oauth_binding','public.fn_meta_immutable_identity()')
  union all select name,'trg_meta_updated_at','public.fn_set_updated_at()' from tables
), trigger_contract as (
  select coalesce(bool_and(exists(select 1 from pg_trigger t
    where t.tgrelid=to_regclass('public.'||e.table_name) and t.tgname=e.name
      and t.tgfoid=to_regprocedure(e.function_signature) and not t.tgisinternal
      and t.tgenabled in ('O','A') and t.tgtype=19 and t.tgattr=''::int2vector
      and t.tgqual is null and t.tgnargs=0 and t.tgconstraint=0)),false) valid
  from triggers e
), foreign_keys(table_name,columns,referenced_table,referenced_columns,delete_action) as (
  select name,array['organization_id'],'public.organizations',array['id'],'c' from tables
  union all values
    ('meta_oauth_attempts',array['actor_id'],'auth.users',array['id'],'c'),
    ('meta_connections',array['local_actor_id'],'auth.users',array['id'],'r'),
    ('meta_campaign_drafts',array['created_by'],'auth.users',array['id'],'r'),
    ('meta_operations',array['actor_id'],'auth.users',array['id'],'r'),
    ('instagram_publications',array['requested_by'],'auth.users',array['id'],'r'),
    ('meta_assets',array['organization_id','parent_page_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('meta_asset_grants',array['organization_id','connection_id'],'public.meta_connections',array['organization_id','id'],'c'),
    ('meta_asset_grants',array['organization_id','asset_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('meta_campaign_drafts',array['organization_id','ad_account_asset_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('meta_campaign_drafts',array['organization_id','page_asset_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('meta_campaign_drafts',array['organization_id','instagram_asset_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('meta_operations',array['organization_id','connection_id'],'public.meta_connections',array['organization_id','id'],'r'),
    ('meta_operations',array['organization_id','asset_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('meta_operations',array['organization_id','grant_id','connection_id','asset_id'],'public.meta_asset_grants',array['organization_id','id','connection_id','asset_id'],'r'),
    ('meta_operations',array['organization_id','campaign_draft_id'],'public.meta_campaign_drafts',array['organization_id','id'],'r'),
    ('instagram_publications',array['organization_id','meta_asset_id'],'public.meta_assets',array['organization_id','id'],'r'),
    ('instagram_publications',array['organization_id','operation_id'],'public.meta_operations',array['organization_id','id'],'r')
), foreign_key_contract as (
  select coalesce(bool_and(exists(select 1 from pg_constraint c
    where c.conrelid=to_regclass('public.'||e.table_name) and c.contype='f' and c.convalidated
      and c.confrelid=to_regclass(e.referenced_table) and c.confdeltype::text=e.delete_action
      and c.confupdtype in ('a','r') and c.confmatchtype='s'
      and array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum,position)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum order by k.position)=e.columns
      and array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum,position)
        join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum order by k.position)=e.referenced_columns
      and (select count(*) from pg_trigger t where t.tgconstraint=c.oid)=4
      and not exists(select 1 from pg_trigger t where t.tgconstraint=c.oid and t.tgenabled not in ('O','A')))),false) valid
  from foreign_keys e
), unique_keys(table_name,columns,primary_key,predicate) as (
  select name,array['id'],true,null::text from tables
  union all select name,array['organization_id','id'],false,null::text from tables
  union all values
    ('meta_oauth_attempts',array['state_hash'],false,null),
    ('meta_oauth_attempts',array['ticket_hash'],false,null),
    ('meta_connections',array['organization_id','app_id','local_actor_id','remote_actor_id'],false,null),
    ('meta_assets',array['organization_id','kind','external_id'],false,null),
    ('meta_asset_grants',array['organization_id','connection_id','asset_id'],false,null),
    ('meta_asset_grants',array['organization_id','id','connection_id','asset_id'],false,null),
    ('meta_operations',array['organization_id','kind','operation_key'],false,null),
    ('instagram_publications',array['organization_id','id'],false,null),
    ('instagram_publications',array['organization_id','operation_id'],false,'(operation_id IS NOT NULL)')
), unique_key_contract as (
  select coalesce(bool_and(exists(select 1 from pg_index i
    where i.indrelid=to_regclass('public.'||e.table_name) and i.indisunique and i.indisvalid
      and i.indisready and i.indimmediate and (not e.primary_key or i.indisprimary)
      and i.indnkeyatts=cardinality(e.columns)
      and array(select a.attname::text from unnest(i.indkey) with ordinality k(attnum,position)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
        where k.position<=i.indnkeyatts order by k.position)=e.columns
      and pg_get_expr(i.indpred,i.indrelid) is not distinct from e.predicate)),false) valid
  from unique_keys e
), checks(table_name,definition) as (values
    ('instagram_publications','CHECK ((((provider = ''zernio''::text) AND (meta_asset_id IS NULL) AND (operation_id IS NULL)) OR ((provider = ''meta''::text) AND (meta_asset_id IS NOT NULL))))'),
    ('meta_assets','CHECK (((parent_page_id IS NULL) OR (kind = ''instagram''::text)))'),
    ('meta_assets','CHECK ((jsonb_typeof(metadata) = ''object''::text))'),
    ('meta_assets','CHECK ((kind = ANY (ARRAY[''page''::text, ''instagram''::text, ''ad_account''::text])))'),
    ('meta_campaign_drafts','CHECK (((status <> ALL (ARRAY[''approved''::text, ''submitted''::text])) OR ((approved_revision = revision) AND (approved_hash IS NOT NULL))))'),
    ('meta_campaign_drafts','CHECK ((approved_hash ~ ''^[0-9a-f]{64}$''::text))'),
    ('meta_campaign_drafts','CHECK ((daily_budget_cents > 0))'),
    ('meta_campaign_drafts','CHECK ((revision > 0))'),
    ('meta_connections','CHECK ((jsonb_typeof(granular_scopes) = ''array''::text))'),
    ('meta_connections','CHECK ((version > 0))'),
    ('meta_oauth_attempts','CHECK (((status <> ''finalized''::text) OR ((pending_result_encrypted IS NULL) AND (finalized_at IS NOT NULL))))'),
    ('meta_oauth_attempts','CHECK (((status <> ''ready''::text) OR ((ticket_hash IS NOT NULL) AND (pending_result_encrypted IS NOT NULL))))'),
    ('meta_oauth_attempts','CHECK ((config_revision > 0))'),
    ('meta_oauth_attempts','CHECK ((cookie_hash ~ ''^[0-9a-f]{64}$''::text))'),
    ('meta_oauth_attempts','CHECK ((state_hash ~ ''^[0-9a-f]{64}$''::text))'),
    ('meta_oauth_attempts','CHECK ((ticket_hash ~ ''^[0-9a-f]{64}$''::text))'),
    ('meta_operations','CHECK (((receipt IS NULL) OR (jsonb_typeof(receipt) = ''object''::text)))'),
    ('meta_operations','CHECK ((authorization_version > 0))'),
    ('meta_operations','CHECK ((fence >= 0))'),
    ('meta_operations','CHECK ((jsonb_typeof(external_ids) = ''object''::text))'),
    ('meta_operations','CHECK ((jsonb_typeof(request_payload) = ''object''::text))'),
    ('meta_operations','CHECK ((request_hash ~ ''^[0-9a-f]{64}$''::text))')
), check_contract as (
  select coalesce(bool_and(exists(select 1 from pg_constraint c
    where c.conrelid=to_regclass('public.'||e.table_name) and c.contype='c'
      and c.convalidated and not c.connoinherit and pg_get_constraintdef(c.oid)=e.definition)),false) valid
  from checks e
), maintenance_index_contract as (
  select exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    join pg_am am on am.oid=c.relam
    where i.indrelid=to_regclass('public.instagram_publications')
      and i.indisvalid and i.indisready and not i.indisunique and am.amname='btree'
      and i.indnkeyatts=1 and i.indoption[0]=0
      and (select a.attname from pg_attribute a where a.attrelid=i.indrelid and a.attnum=i.indkey[0])='created_at'
      and pg_get_expr(i.indpred,i.indrelid)='((provider = ''meta''::text) AND (status = ''preparing''::text) AND (operation_id IS NULL))') valid
), dependencies as (
  select to_regclass('public.platform_meta_app') is not null
    and to_regclass('public.instagram_publications') is not null
    and to_regclass('public.platform_admins') is not null
    and to_regclass('public.user_organizations') is not null
    and to_regprocedure('public.fn_decrypt_oauth(bytea)') is not null
    and to_regprocedure('public.fn_set_updated_at()') is not null
    and to_regprocedure('public.fn_user_org_ids()') is not null valid
)
select case
  when not d.valid then 'dependencies_missing'
  when t.installed=0 and f.installed=0 and c.installed=0 then 'missing'
  when t.installed=6 and f.installed=20 and c.installed=c.expected and t.valid and f.valid and c.valid
    and tr.valid and fk.valid and uk.valid and ck.valid and mi.valid then 'ready'
  else 'incompatible'
end
from table_contract t cross join function_contract f cross join column_contract c cross join dependencies d
cross join trigger_contract tr cross join foreign_key_contract fk cross join unique_key_contract uk
cross join check_contract ck cross join maintenance_index_contract mi;
