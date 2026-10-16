-- Catalog-only guard: never reads application/customer rows and never repairs drift.
-- A preflight accepts the 7c4e885 objects or this release's exact definitions.
-- A postflight requires the new definitions. Run as postgres, with ON_ERROR_STOP.
do $release_guard$
declare
  require_new constant boolean := true;
  postgres_oid oid := (select oid from pg_catalog.pg_roles where rolname = 'postgres');
  obj oid;
  ns oid;
  p record;
  item record;
  names text[];
  expression text;
  actual text;
  old_view text;
  new_view text;
  bit_present boolean;
  sources_present boolean;
  old_column_names text[] := array['id','organization_id','label','host','port','database_name','username',
    'ssl_mode','enabled','max_rows','max_filters','max_response_bytes','last_tested_at','last_test_ok',
    'last_test_error','created_by','created_at','updated_at'];
  role_name text;
begin
  if current_user <> 'postgres' or postgres_oid is null then
    raise exception 'Release guard requires postgres; no schema ownership is inferred';
  end if;

  -- Never adopt a relation or a pre-existing namespace only because its name matches.
  ns := pg_catalog.to_regnamespace('escreveai_ops');
  obj := pg_catalog.to_regclass('escreveai_ops.schema_releases');
  if ns is null then
    if require_new then raise exception 'Private release journal schema is missing'; end if;
  else
    if not exists (select 1 from pg_catalog.pg_namespace where oid = ns and nspowner = postgres_oid) then
      raise exception 'Unknown owner of escreveai_ops';
    end if;
    if exists (select 1 from pg_catalog.pg_namespace n,
      lateral pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      where n.oid = ns and a.grantee <> postgres_oid) then
      raise exception 'Private journal namespace has unexpected ACL';
    end if;
    foreach role_name in array array['anon','authenticated','service_role'] loop
      if pg_catalog.has_schema_privilege(role_name, ns, 'USAGE,CREATE') then
        raise exception 'Private journal namespace is accessible to %', role_name;
      end if;
    end loop;
    if exists (select 1 from pg_catalog.pg_class where relnamespace = ns
      and (relname not in ('schema_releases','schema_releases_pkey') or relkind not in ('r','i')))
      or exists (select 1 from pg_catalog.pg_proc where pronamespace = ns)
      or exists (select 1 from pg_catalog.pg_type t where t.typnamespace=ns
        and t.typrelid is distinct from obj and not exists
          (select 1 from pg_catalog.pg_class c where c.oid=obj and c.reltype=t.typelem)) then
      raise exception 'Unknown objects in private release journal namespace';
    end if;
    if obj is null then
      if require_new or exists (select 1 from pg_catalog.pg_class where relnamespace = ns) then
        raise exception 'Private release journal table is missing or namespace is incomplete';
      end if;
    else
      select * into p from pg_catalog.pg_class where oid = obj;
      if p.relkind <> 'r' or p.relpersistence <> 'p' or p.relowner <> postgres_oid
        or p.relrowsecurity or p.relforcerowsecurity or p.relispartition then
        raise exception 'Unknown release journal relation type/owner/security';
      end if;
      select array_agg(attname::text order by attnum) into names from pg_catalog.pg_attribute
        where attrelid = obj and attnum > 0;
      if names is distinct from array['release','checksum','applied_at']::text[] then
        raise exception 'Unknown release journal columns';
      end if;
      if exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = obj and a.attnum > 0
        and (a.attisdropped or not a.attnotnull or a.attidentity <> '' or a.attgenerated <> ''
          or a.atttypmod <> -1 or a.atttypid is distinct from (case a.attname when 'applied_at'
            then 'pg_catalog.timestamptz'::regtype else 'pg_catalog.text'::regtype end))) then
        raise exception 'Unknown release journal column types';
      end if;
      if (select count(*) from pg_catalog.pg_attrdef where adrelid = obj) <> 1
        or not exists (select 1 from pg_catalog.pg_attrdef d join pg_catalog.pg_attribute a
          on a.attrelid = d.adrelid and a.attnum = d.adnum
          where d.adrelid = obj and a.attname = 'applied_at' and pg_catalog.pg_get_expr(d.adbin,d.adrelid) = 'now()') then
        raise exception 'Unknown release journal defaults';
      end if;
      if (select count(*) from pg_catalog.pg_constraint where conrelid = obj) <> 1
        or not exists (select 1 from pg_catalog.pg_constraint where conrelid = obj
          and contype = 'p' and conkey = array[1]::smallint[] and convalidated and not condeferrable)
        or (select count(*) from pg_catalog.pg_index where indrelid = obj) <> 1
        or exists (select 1 from pg_catalog.pg_index where indrelid = obj
          and (not indisprimary or not indisunique or not indisvalid or not indisready or indnatts <> 1 or indpred is not null or indexprs is not null))
        or exists (select 1 from pg_catalog.pg_trigger where tgrelid = obj and not tgisinternal)
        or exists (select 1 from pg_catalog.pg_rewrite where ev_class = obj)
        or exists (select 1 from pg_catalog.pg_policy where polrelid = obj) then
        raise exception 'Unknown release journal constraints/indexes/triggers/rules';
      end if;
      if exists (select 1 from pg_catalog.pg_class c,
        lateral pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
        where c.oid = obj and a.grantee <> postgres_oid)
        or exists (select 1 from pg_catalog.pg_attribute c, lateral pg_catalog.aclexplode(c.attacl) a
          where c.attrelid = obj and c.attnum > 0 and a.grantee <> postgres_oid) then
        raise exception 'Private release journal has unexpected table/column ACL';
      end if;
      foreach role_name in array array['anon','authenticated','service_role'] loop
        if pg_catalog.has_table_privilege(role_name, obj, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or pg_catalog.has_any_column_privilege(role_name, obj, 'SELECT,INSERT,UPDATE,REFERENCES') then
          raise exception 'Private release journal is accessible to %', role_name;
        end if;
      end loop;
    end if;
  end if;

  -- Required base relations/column types, not a guess that old migrations ran.
  for item in select * from (values
    ('send_ledger','organization_id','uuid'), ('send_ledger','contact_id','uuid'), ('send_ledger','status','text'),
    ('llm_calls','job_id','uuid'), ('lead_checkpoints','job_id','uuid'), ('lead_state_transitions','job_id','uuid'),
    ('event_log','event_type','text'), ('event_log','status','text'),
    ('conversations','organization_id','uuid'), ('conversations','contact_id','uuid'),
    ('contacts','force_human','bool'), ('contacts','is_blocked','bool'),
    ('external_db_connections','id','uuid'), ('external_db_connections','organization_id','uuid')
  ) as required(table_name,column_name,type_name) loop
    if not exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relname = item.table_name and c.relkind = 'r'
        and a.attname = item.column_name and not a.attisdropped
        and a.atttypid = pg_catalog.to_regtype('pg_catalog.' || item.type_name)) then
      raise exception 'Required base column %.% has unknown type or is missing', item.table_name, item.column_name;
    end if;
  end loop;

  bit_present := exists (select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.conversations'::regclass and attname = 'contato_trava_humano' and not attisdropped);
  sources_present := exists (select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.external_db_connections'::regclass and attname = 'source_mode' and not attisdropped);
  if require_new and (not bit_present or not sources_present) then raise exception 'Release columns are missing'; end if;

  for item in select * from (values
    ('public.conversations','contato_trava_humano','bool','false',bit_present),
    ('public.external_db_connections','source_mode','text',quote_literal('all') || '::text',sources_present),
    ('public.external_db_connections','sources','jsonb',quote_literal('[]') || '::jsonb',sources_present)
  ) as columns_expected(table_name,column_name,type_name,default_expr,present) loop
    select a.*, pg_catalog.pg_get_expr(d.adbin,d.adrelid) as default_sql into p
      from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = pg_catalog.to_regclass(item.table_name) and a.attname = item.column_name and not a.attisdropped;
    if not found then
      if item.present then raise exception 'Release column %.% is missing', item.table_name,item.column_name; end if;
    elsif not item.present or p.atttypid is distinct from pg_catalog.to_regtype('pg_catalog.' || item.type_name)
      or not p.attnotnull or p.atttypmod <> -1 or p.attidentity <> '' or p.attgenerated <> ''
      or p.default_sql is distinct from item.default_expr then
      raise exception 'Unknown release column %.%',item.table_name,item.column_name;
    end if;
  end loop;

  -- Bodies are raw pg_proc.prosrc MD5s, extracted from the reviewed SQL, not pg_get_functiondef formatting.
  for item in select * from (values
    ('public.comando_da_conversa(public.conversations)','6c25fb7cef66ebdccfd116ee333b436f','16ff68fa94ba0fdd784ecfaa4e7cc8de','sql',true,'s','text','app',true),
    ('public.fn_attendant_metrics(uuid,timestamptz,timestamptz,uuid)','d843df495f2abd80d123f18bfd435dd2','ccf7ec4e77f44e7e3379eb696f733821','sql',false,'s','jsonb','app',true),
    ('public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text)','5f3bfc452be9b0bc8e8aba646a820fee','d93b2048e8d17f26d1fea1f03ea122ac','plpgsql',true,'v','record','service',true),
    ('public.fn_conversa_calcula_trava_do_contato()',null,'d9fb0f6222e5e891700af042cd1dd075','plpgsql',true,'v','trigger','trigger',bit_present),
    ('public.fn_contato_atualiza_trava_nas_conversas()',null,'e7f2fba5beb786d7d455f32d1d3ca413','plpgsql',true,'v','trigger','trigger',bit_present)
  ) as funcs(signature,old_hash,new_hash,language_name,definer,volatility,result_type,access_kind,present) loop
    obj := pg_catalog.to_regprocedure(item.signature);
    if obj is null then
      if item.present then raise exception 'Required function missing: %',item.signature; end if;
      continue;
    end if;
    select f.*, l.lanname into p from pg_catalog.pg_proc f join pg_catalog.pg_language l on l.oid=f.prolang where f.oid=obj;
    if not item.present or p.proowner <> postgres_oid or p.prokind <> 'f'
      or p.lanname <> item.language_name or p.prosecdef <> (case
        when item.signature = 'public.comando_da_conversa(public.conversations)' and pg_catalog.md5(p.prosrc) = item.old_hash
          then false else item.definer end)
      or p.provolatile::text <> item.volatility or p.proisstrict or p.proretset <> (item.access_kind = 'service')
      or p.prorettype is distinct from pg_catalog.to_regtype('pg_catalog.' || item.result_type)
      or p.proconfig is distinct from array['search_path=public']::text[]
      or (pg_catalog.md5(p.prosrc) <> item.new_hash and
        (require_new or item.old_hash is null or pg_catalog.md5(p.prosrc) <> item.old_hash)) then
      raise exception 'Unknown function body/type/security: %',item.signature;
    end if;
    if item.signature = 'public.comando_da_conversa(public.conversations)' and
      p.proargnames is distinct from (case when bit_present then null::text[] else array['c']::text[] end) then
      raise exception 'Conversation function has unknown argument naming';
    end if;
    if item.signature = 'public.comando_da_conversa(public.conversations)' and
      ((bit_present and pg_catalog.md5(p.prosrc) <> item.new_hash) or (not bit_present and pg_catalog.md5(p.prosrc) <> item.old_hash)) then
      raise exception 'Conversation function/column state is inconsistent';
    end if;
    if exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      where a.grantee = 0 and a.privilege_type = 'EXECUTE')
      or pg_catalog.has_function_privilege('anon',obj,'EXECUTE') then
      raise exception 'Function exposed to PUBLIC/anon: %',item.signature;
    end if;
    if item.access_kind = 'app' and (not pg_catalog.has_function_privilege('authenticated',obj,'EXECUTE')
      or not pg_catalog.has_function_privilege('service_role',obj,'EXECUTE')) then
      raise exception 'Application function lost required execute grants: %',item.signature;
    elsif item.access_kind = 'service' and (pg_catalog.has_function_privilege('authenticated',obj,'EXECUTE')
      or not pg_catalog.has_function_privilege('service_role',obj,'EXECUTE')) then
      raise exception 'Publish function must remain service-only: %',item.signature;
    elsif item.access_kind = 'trigger' and (pg_catalog.has_function_privilege('authenticated',obj,'EXECUTE')
      or pg_catalog.has_function_privilege('service_role',obj,'EXECUTE')) then
      raise exception 'Trigger function is callable by application roles: %',item.signature;
    end if;
  end loop;

  for item in select * from (values
    ('conversations','trg_conversa_calcula_trava_do_contato','public.fn_conversa_calcula_trava_do_contato()',23,array['contact_id','contato_trava_humano','organization_id']::text[]),
    ('contacts','trg_contato_atualiza_trava_nas_conversas','public.fn_contato_atualiza_trava_nas_conversas()',17,array['force_human','is_blocked']::text[])
  ) as triggers_expected(table_name,trigger_name,signature,kind,columns) loop
    select * into p from pg_catalog.pg_trigger where tgrelid=pg_catalog.to_regclass('public.'||item.table_name) and tgname=item.trigger_name;
    if not found then
      if bit_present then raise exception 'Release trigger missing: %',item.trigger_name; end if;
    else
      select array_agg(a.attname::text order by a.attname::text) into names from unnest(p.tgattr::smallint[]) k
        join pg_catalog.pg_attribute a on a.attrelid=p.tgrelid and a.attnum=k;
      if not bit_present or p.tgisinternal or p.tgtype <> item.kind or p.tgenabled <> 'O' or p.tgnargs <> 0
        or p.tgqual is not null or p.tgconstraint <> 0 or p.tgfoid <> pg_catalog.to_regprocedure(item.signature)
        or names is distinct from item.columns then
        raise exception 'Unknown trigger definition: %',item.trigger_name;
      end if;
    end if;
  end loop;

  -- IF NOT EXISTS on CREATE INDEX must never silently keep a same-name wrong index.
  for item in select * from (values
    ('idx_send_ledger_contato_entregue','send_ledger',array['organization_id','contact_id']::text[],'status=ANY(ARRAY[''accepted''::text,''queued''::text])',require_new),
    ('idx_llm_calls_job_id','llm_calls',array['job_id'],'job_idISNOTNULL',require_new),
    ('idx_lead_checkpoints_job_id','lead_checkpoints',array['job_id'],'job_idISNOTNULL',require_new),
    ('idx_lead_state_transitions_job_id','lead_state_transitions',array['job_id'],'job_idISNOTNULL',require_new),
    ('event_log_processing_por_tipo_idx','event_log',array['event_type'],'status=''processing''::text',require_new),
    ('conversations_contact_id_idx','conversations',array['contact_id'],null,bit_present)
  ) as indexes_expected(index_name,table_name,columns,predicate,present) loop
    obj := pg_catalog.to_regclass('public.'||item.index_name);
    if obj is null then
      if item.present then raise exception 'Release index missing: %',item.index_name; end if;
      continue;
    end if;
    select i.*,c.relkind,c.relowner,am.amname into p from pg_catalog.pg_index i
      join pg_catalog.pg_class c on c.oid=i.indexrelid join pg_catalog.pg_am am on am.oid=c.relam where i.indexrelid=obj;
    if not found then raise exception 'Index name belongs to another object: %',item.index_name; end if;
    select array_agg(pg_catalog.pg_get_indexdef(obj,k,false) order by k) into names
      from generate_series(1,p.indnkeyatts) k;
    actual := pg_catalog.regexp_replace(lower(pg_catalog.pg_get_expr(p.indpred,p.indrelid)),'[[:space:]()]','','g');
    expression := pg_catalog.regexp_replace(lower(item.predicate),'[[:space:]()]','','g');
    if p.relkind <> 'i' or p.relowner <> postgres_oid or p.amname <> 'btree'
      or p.indrelid <> pg_catalog.to_regclass('public.'||item.table_name)
      or not p.indisvalid or not p.indisready or not p.indislive or p.indisunique or p.indisprimary
      or p.indnatts <> cardinality(item.columns) or p.indnkeyatts <> p.indnatts or p.indexprs is not null
      or names is distinct from item.columns or actual is distinct from expression then
      raise exception 'Unknown index definition: %',item.index_name;
    end if;
  end loop;

  for item in select * from (values
    ('external_db_connections_source_mode_valido','CHECK (source_mode = ANY (ARRAY[''all''::text, ''list''::text]))'),
    ('external_db_connections_sources_valido','CHECK ((jsonb_typeof(sources) = ''array''::text) AND (octet_length((sources)::text) <= 262144))')
  ) as constraints_expected(name,definition) loop
    select * into p from pg_catalog.pg_constraint where conrelid='public.external_db_connections'::regclass and conname=item.name;
    if not found then
      if sources_present then raise exception 'Release constraint missing: %',item.name; end if;
    elsif not sources_present or p.contype <> 'c' or not p.convalidated or p.condeferrable
      or pg_catalog.regexp_replace(lower(pg_catalog.pg_get_constraintdef(p.oid)),'[[:space:]()]','','g')
        <> pg_catalog.regexp_replace(lower(item.definition),'[[:space:]()]','','g') then
      raise exception 'Unknown source constraint: %',item.name;
    end if;
  end loop;

  if not exists (select 1 from pg_catalog.pg_class where oid='public.external_db_connections'::regclass and relrowsecurity) then
    raise exception 'External DB connections lost row-level security';
  end if;
  obj := pg_catalog.to_regclass('public.external_db_connections_safe');
  select * into p from pg_catalog.pg_class where oid=obj;
  if not found or p.relkind <> 'v' or p.relowner <> postgres_oid
    or not coalesce(p.reloptions @> array['security_invoker=true']::text[],false) then
    raise exception 'Safe external DB view missing or lacks security_invoker';
  end if;
  select array_agg(attname::text order by attnum) into names from pg_catalog.pg_attribute where attrelid=obj and attnum>0 and not attisdropped;
  if names is distinct from (old_column_names || case when sources_present then array['source_mode','sources_count']::text[] else array[]::text[] end) then
    raise exception 'Safe external DB view has unknown columns';
  end if;
  select 'select' || string_agg(c,',' order by ordinal) into old_view
    from unnest(old_column_names) with ordinality as cols(c,ordinal);
  new_view := old_view || ',source_mode,jsonb_array_length(sources)assources_countfromexternal_db_connections;';
  old_view := old_view || 'fromexternal_db_connections;';
  actual := replace(pg_catalog.regexp_replace(lower(pg_catalog.pg_get_viewdef(obj,false)),'[[:space:]]','','g'),'public.external_db_connections','external_db_connections');
  actual := replace(actual,'external_db_connections.','');
  if actual is distinct from (case when sources_present then new_view else old_view end) then
    raise exception 'Safe external DB view has unknown query';
  end if;
  if exists (select 1 from pg_catalog.aclexplode(coalesce(p.relacl,pg_catalog.acldefault('r',p.relowner))) a where a.grantee=0)
    or exists (select 1 from pg_catalog.pg_attribute c, lateral pg_catalog.aclexplode(c.attacl) a
      where c.attrelid=obj and c.attnum>0 and a.grantee=0)
    or pg_catalog.has_table_privilege('anon',obj,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or pg_catalog.has_any_column_privilege('anon',obj,'SELECT,INSERT,UPDATE,REFERENCES')
    or not pg_catalog.has_table_privilege('authenticated',obj,'SELECT') then
    raise exception 'Safe external DB view has unexpected public access or lost authenticated SELECT';
  end if;
end;
$release_guard$;
