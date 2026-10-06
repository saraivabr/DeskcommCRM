-- 0417 contract: classify absence/partial state before stopping live services;
-- function body hashes are deliberately not pinned, preserving forward fixes.
with tables(name) as (values
  ('meta_privacy_subjects'),('meta_privacy_requests'),('meta_privacy_targets'),('meta_privacy_storage_objects'),('meta_privacy_media_tombstones')
), table_contract as (
  select count(c.oid) installed,coalesce(bool_and(c.relkind='r' and c.relrowsecurity
    and has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    and not has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    and not has_any_column_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl where acl.grantee=0)),false) valid
  from tables t left join pg_class c on c.oid=to_regclass('public.'||t.name)
), columns(table_name,name,type_name,not_null,default_expression) as (values
  ('meta_privacy_subjects','subject_hash','text',true,null),
  ('meta_privacy_subjects','app_id','text',true,null),
  ('meta_privacy_subjects','cutoff_at','timestamptz',true,null),
  ('meta_privacy_subjects','status','text',true,'''pending''::text'),
  ('meta_privacy_subjects','created_at','timestamptz',true,'now()'),
  ('meta_privacy_subjects','updated_at','timestamptz',true,'now()'),
  ('meta_privacy_requests','id','uuid',true,'gen_random_uuid()'),
  ('meta_privacy_requests','subject_hash','text',true,null),
  ('meta_privacy_requests','app_id','text',true,null),
  ('meta_privacy_requests','kind','text',true,null),
  ('meta_privacy_requests','request_digest','text',true,null),
  ('meta_privacy_requests','confirmation_code_hash','text',true,null),
  ('meta_privacy_requests','confirmation_code_encrypted','bytea',true,null),
  ('meta_privacy_requests','issued_at','timestamptz',true,null),
  ('meta_privacy_requests','status','text',true,'''pending''::text'),
  ('meta_privacy_requests','lease_owner','text',false,null),
  ('meta_privacy_requests','lease_until','timestamptz',false,null),
  ('meta_privacy_requests','fence','bigint',true,'0'),
  ('meta_privacy_requests','completed_at','timestamptz',false,null),
  ('meta_privacy_requests','created_at','timestamptz',true,'now()'),
  ('meta_privacy_targets','subject_hash','text',true,null),
  ('meta_privacy_targets','connection_id','uuid',true,null),
  ('meta_privacy_targets','organization_id','uuid',true,null),
  ('meta_privacy_targets','asset_ids','uuid[]',true,'''{}''::uuid[]'),
  ('meta_privacy_storage_objects','id','uuid',true,'gen_random_uuid()'),
  ('meta_privacy_storage_objects','subject_hash','text',true,null),
  ('meta_privacy_storage_objects','organization_id','uuid',true,null),
  ('meta_privacy_storage_objects','publication_id','uuid',true,null),
  ('meta_privacy_storage_objects','object_index','integer',true,null),
  ('meta_privacy_storage_objects','created_at','timestamptz',true,'now()'),
  ('meta_privacy_media_tombstones','organization_id','uuid',true,null),
  ('meta_privacy_media_tombstones','publication_id','uuid',true,null),
  ('meta_privacy_media_tombstones','created_at','timestamptz',true,'now()'),
  ('meta_privacy_requests','retry_at','timestamptz',true,'now()'),
  ('instagram_publications','meta_media_cleanup_uncertain','boolean',true,'false'),
  ('instagram_publications','meta_connection_id','uuid',false,null),
  ('meta_campaign_drafts','meta_connection_id','uuid',false,null)
), column_contract as (
  select coalesce(bool_and(a.attnum is not null and a.atttypid=to_regtype(c.type_name)
    and a.attnotnull=c.not_null and pg_get_expr(d.adbin,d.adrelid) is not distinct from c.default_expression),false) valid,
    count(a.attnum) filter(where c.table_name in ('instagram_publications','meta_campaign_drafts')) attribution_installed
  from columns c left join pg_attribute a on a.attrelid=to_regclass('public.'||c.table_name) and a.attname=c.name and not a.attisdropped
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
), functions(signature,result,definer,service_execute) as (values
  ('public.fn_meta_privacy_subject_hash(text,text)','text',true,true),
  ('public.fn_meta_privacy_storage_fence()','trigger',true,false),
  ('public.fn_meta_privacy_oauth_result_guard()','trigger',false,false),
  ('public.fn_meta_privacy_connection_guard()','trigger',false,false),
  ('public.fn_meta_privacy_attribution_guard()','trigger',false,false),
  ('public.fn_meta_privacy_request(text,text,text,text,text,timestamptz)','jsonb',false,true),
  ('public.fn_meta_privacy_claim(text,integer)','jsonb',false,true),
  ('public.fn_meta_privacy_step(uuid,text,bigint,uuid[],integer)','jsonb',false,true),
  ('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)','bigint',false,true),
  ('public.fn_meta_oauth_finalize(uuid,uuid,text,text)','jsonb',false,true),
  ('public.fn_meta_operation_authorized(uuid)','boolean',false,true)
), function_contract as (
  select count(p.oid) filter(where f.signature like 'public.fn_meta_privacy_%') installed,
    coalesce(bool_and(p.oid is not null and p.prokind='f' and p.prosecdef=f.definer and p.prorettype=to_regtype(f.result)
    and coalesce(p.proconfig,'{}'::text[]) @> array['search_path=""']
    and (f.signature<>'public.fn_meta_privacy_storage_fence()' or p.proowner=(select relowner from pg_class where oid=to_regclass('public.meta_privacy_media_tombstones'))) 
    and has_function_privilege('service_role',p.oid,'EXECUTE')=f.service_execute
    and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
    and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE')),false) valid
  from functions f left join pg_proc p on p.oid=to_regprocedure(f.signature)
), markers(signature) as (values
  ('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)'),
  ('public.fn_meta_oauth_finalize(uuid,uuid,text,text)'),('public.fn_meta_operation_authorized(uuid)')
), marker_contract as (
  select count(*) filter(where obj_description(to_regprocedure(signature),'pg_proc') like 'meta-privacy-0417-%') installed
  from markers
), triggers(table_name,name,function_name) as (values
  ('meta_oauth_attempts','trg_meta_privacy_oauth_result_guard','public.fn_meta_privacy_oauth_result_guard()'),
  ('storage.objects','trg_meta_privacy_storage_fence','public.fn_meta_privacy_storage_fence()'),
  ('meta_connections','trg_meta_privacy_connection_guard','public.fn_meta_privacy_connection_guard()'),
  ('instagram_publications','trg_meta_privacy_publication_attribution','public.fn_meta_privacy_attribution_guard()'),
  ('meta_campaign_drafts','trg_meta_privacy_draft_attribution','public.fn_meta_privacy_attribution_guard()')
), trigger_contract as (
  select count(t.oid) installed,coalesce(bool_and(t.oid is not null and t.tgtype=23 and t.tgenabled='O'
    and t.tgfoid=to_regprocedure(x.function_name)),false) valid
  from triggers x left join pg_trigger t on t.tgrelid=to_regclass(case when x.table_name='storage.objects' then x.table_name else 'public.'||x.table_name end) and t.tgname=x.name and not t.tgisinternal
), foreign_keys(source_table,source_columns,target_table,target_columns) as (values
  ('meta_privacy_requests',array['subject_hash'],'meta_privacy_subjects',array['subject_hash']),
  ('meta_privacy_targets',array['subject_hash'],'meta_privacy_subjects',array['subject_hash']),
  ('meta_privacy_storage_objects',array['subject_hash'],'meta_privacy_subjects',array['subject_hash']),
  ('instagram_publications',array['organization_id','meta_connection_id'],'meta_connections',array['organization_id','id']),
  ('meta_campaign_drafts',array['organization_id','meta_connection_id'],'meta_connections',array['organization_id','id']),
  ('meta_operations',array['organization_id','campaign_draft_id','connection_id'],'meta_campaign_drafts',array['organization_id','id','meta_connection_id'])
), fk_contract as (
  select bool_and(exists(select 1 from pg_constraint c where c.contype='f' and c.convalidated and c.confdeltype='r'
    and c.conrelid=to_regclass('public.'||f.source_table) and c.confrelid=to_regclass('public.'||f.target_table)
    and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(num,ord)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num)=f.source_columns
    and (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(num,ord)
      join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num)=f.target_columns)) valid from foreign_keys f
), indexes(table_name,name,column_names,unique_key,predicate) as (values
  ('meta_privacy_media_tombstones','meta_privacy_media_tombstones_pkey',array['organization_id','publication_id'],true,null),
  ('meta_privacy_subjects','meta_privacy_subjects_pkey',array['subject_hash'],true,null),
  ('meta_privacy_subjects','meta_privacy_subjects_app_status_idx',array['app_id','status'],false,null),
  ('meta_privacy_requests','meta_privacy_requests_pkey',array['id'],true,null),
  ('meta_privacy_requests','meta_privacy_requests_app_id_kind_request_digest_key',array['app_id','kind','request_digest'],true,null),
  ('meta_privacy_requests','meta_privacy_requests_confirmation_code_hash_key',array['confirmation_code_hash'],true,null),
  ('meta_privacy_requests','meta_privacy_requests_subject_idx',array['subject_hash','status'],false,null),
  ('meta_privacy_requests','meta_privacy_requests_due_idx',array['retry_at','created_at','id'],false,'status<>''completed''::text'),
  ('meta_privacy_targets','meta_privacy_targets_pkey',array['subject_hash','connection_id'],true,null),
  ('meta_privacy_storage_objects','meta_privacy_storage_objects_pkey',array['id'],true,null),
  ('meta_privacy_storage_objects','meta_privacy_storage_objects_subject_hash_organization_id_p_key',array['subject_hash','organization_id','publication_id','object_index'],true,null),
  ('meta_privacy_storage_objects','meta_privacy_storage_objects_due_idx',array['subject_hash','created_at','id'],false,null),
  ('instagram_publications','instagram_publications_meta_connection_idx',array['organization_id','meta_connection_id'],false,'meta_connection_idisnotnull'),
  ('meta_campaign_drafts','meta_campaign_drafts_connection_idx',array['organization_id','meta_connection_id'],false,'meta_connection_idisnotnull'),
  ('meta_campaign_drafts','meta_campaign_drafts_connection_uk',array['organization_id','id','meta_connection_id'],true,null)
), index_contract as (
  select coalesce(bool_and(i.indexrelid is not null and i.indisvalid and i.indisready and i.indisunique=x.unique_key
    and (select array_agg(a.attname::text order by k.ord) from unnest(i.indkey::smallint[]) with ordinality k(num,ord)
      join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num where k.ord<=i.indnkeyatts)=x.column_names
    and regexp_replace(lower(pg_get_expr(i.indpred,i.indrelid)),'[()[:space:]]','','g') is not distinct from x.predicate),false) valid
  from indexes x left join pg_index i on i.indexrelid=to_regclass('public.'||x.name) and i.indrelid=to_regclass('public.'||x.table_name)
), checks(table_name,column_name,pattern) as (values
  ('meta_privacy_subjects','subject_hash','subject_hash ~'),('meta_privacy_subjects','app_id','app_id ~'),
  ('meta_privacy_subjects','status','pending.*completed'),('meta_privacy_requests','kind','deauthorization.*data_deletion'),
  ('meta_privacy_requests','request_digest','request_digest ~'),('meta_privacy_requests','confirmation_code_hash','confirmation_code_hash ~'),
  ('meta_privacy_requests','status','pending.*processing.*completed'),('meta_privacy_requests','fence','fence >= 0'),
  ('meta_privacy_requests','completed_at','completed_at IS NOT NULL'),('meta_privacy_requests','lease_owner','lease_owner IS NULL.*lease_until IS NULL'),
  ('meta_privacy_targets','asset_ids','cardinality\(asset_ids\) <= 2000'),
  ('meta_privacy_storage_objects','object_index','object_index >= 0.*object_index <= 9')
), check_contract as (
  select bool_and(exists(select 1 from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attname=x.column_name
    where c.conrelid=to_regclass('public.'||x.table_name) and c.contype='c' and c.convalidated and a.attnum=any(c.conkey)
      and pg_get_constraintdef(c.oid) ~ x.pattern)) valid from checks x
), approved_core(signature,source_hash) as (values
    ('public.fn_meta_app_configure(text,text,boolean,boolean,boolean,uuid,bigint,bytea)','af56fbc10a73e4c28395994ff694641c'),
    ('public.fn_meta_oauth_finalize(uuid,uuid,text,text)','166333c3e3c189becdb3bb0e86106fd3'),
    ('public.fn_meta_operation_authorized(uuid)','1b050b0ffcae618822107679dcfefa38')
), core_contract as (
  select coalesce(bool_and(p.oid is not null and md5(p.prosrc)=a.source_hash),false) known
  from approved_core a left join pg_proc p on p.oid=to_regprocedure(a.signature)
), dependencies as (
  select to_regclass('public.meta_connections') is not null and to_regclass('public.meta_operations') is not null
    and to_regclass('public.meta_assets') is not null and to_regclass('public.meta_asset_grants') is not null
    and to_regclass('public.meta_campaign_drafts') is not null and to_regclass('public.meta_oauth_attempts') is not null
    and to_regclass('storage.objects') is not null
    and exists(select 1 from pg_attribute where attrelid=to_regclass('storage.objects') and attname='bucket_id' and atttypid='text'::regtype and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=to_regclass('storage.objects') and attname='name' and atttypid='text'::regtype and not attisdropped)
    and to_regprocedure('private.fn_oauth_key()') is not null and to_regprocedure('public.fn_encrypt_oauth(text)') is not null
    and to_regprocedure('public.fn_decrypt_oauth(bytea)') is not null and exists(select 1 from pg_extension where extname='pgcrypto') ready
)
select case
  when t.installed=0 and c.attribution_installed=0 and f.installed=0 and m.installed=0 and g.installed=0
    then case when not d.ready then 'dependencies_missing' when b.known then 'missing' else 'incompatible' end
  when t.installed<>5 or c.attribution_installed<>3 or f.installed<>8 or m.installed<>3 or g.installed<>5 then 'partial'
  when not d.ready then 'dependencies_missing'
  when t.valid and c.valid and f.valid and g.valid and k.valid and i.valid and h.valid then 'ready'
  else 'incompatible'
end
from table_contract t cross join column_contract c cross join function_contract f cross join marker_contract m
  cross join trigger_contract g cross join fk_contract k cross join index_contract i cross join check_contract h cross join dependencies d cross join core_contract b;
