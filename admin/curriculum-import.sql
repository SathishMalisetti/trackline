-- Additive VCAA source import support. Apply once after admin/schema.sql.
create table public.curriculum_source_imports (
 id uuid primary key default gen_random_uuid(), requested_by uuid not null references public.platform_admins(id),
 subject text not null check(subject in ('Mathematics','English','Science')),
 year_levels integer[] not null check(cardinality(year_levels) between 1 and 2 and year_levels <@ array[4,7]),
 source_url text not null, status text not null default 'queued' check(status in ('queued','running','completed','failed','cancelled')),
 lease_id uuid, lease_until timestamptz, attempts integer not null default 0, error text,
 source_sha256 text check(source_sha256 ~ '^[a-f0-9]{64}$'), source_fetched_at timestamptz, source_bytes integer,
 source_etag text, source_last_modified text, source_build_id text, parser_version text,
 source_archive_base64 text, attribution text, licence_url text,
 summary jsonb not null default '{}', created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index one_active_source_import on public.curriculum_source_imports(subject) where status in ('queued','running');
create index source_import_queue on public.curriculum_source_imports(created_at) where status in ('queued','running');
create index source_import_owner on public.curriculum_source_imports(requested_by);
alter table public.curriculum_units add column source_import_id uuid references public.curriculum_source_imports(id);
alter table public.curriculum_units add column source_record_hash text check(source_record_hash ~ '^[a-f0-9]{64}$');
alter table public.curriculum_units add column source_details jsonb not null default '{}';
alter table public.curriculum_units add column supersedes_unit_id uuid references public.curriculum_units(id);
alter table public.curriculum_units add column source_current boolean not null default true;
alter table public.curriculum_units add column source_last_seen_import_id uuid references public.curriculum_source_imports(id);
create unique index unique_imported_reference on public.curriculum_units(subject,year_level,curriculum_version,descriptor_code,source_record_hash) where source_import_id is not null;
create index curriculum_reference_import on public.curriculum_units(source_import_id);
create index curriculum_reference_observation on public.curriculum_units(source_last_seen_import_id);
create index curriculum_reference_predecessor on public.curriculum_units(supersedes_unit_id);
create table public.curriculum_import_items (
 import_id uuid not null references public.curriculum_source_imports(id), unit_id uuid not null references public.curriculum_units(id),
 change_type text not null check(change_type in ('created','unchanged','revised')), primary key(import_id,unit_id)
);
create index curriculum_import_item_unit on public.curriculum_import_items(unit_id);
alter table public.curriculum_source_imports enable row level security;
alter table public.curriculum_import_items enable row level security;
revoke all on public.curriculum_source_imports,public.curriculum_import_items from public,anon,authenticated;
grant select,insert,update,delete on public.curriculum_source_imports,public.curriculum_import_items to service_role;

create function public.admin_queue_curriculum_import(p_admin uuid,p_subjects text[],p_years integer[]) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s text; y integer[]; j uuid; queued integer=0; active integer=0; begin
 if cardinality(p_subjects) not between 1 and 3 or p_subjects is null or not p_subjects <@ array['Mathematics','English','Science'] or array_position(p_subjects,null) is not null then raise exception 'Select supported subjects'; end if;
 if p_years is null or cardinality(p_years) not between 1 and 2 or not p_years <@ array[4,7] or array_position(p_years,null) is not null then raise exception 'Select Year 4 or 7'; end if;
 select array_agg(distinct v order by v) into y from unnest(p_years) v;
 perform pg_advisory_xact_lock(91824712);
 for s in select distinct v from unnest(p_subjects) v loop
  if exists(select 1 from public.curriculum_source_imports where subject=s and status in ('queued','running')) then active=active+1; continue; end if;
  insert into public.curriculum_source_imports(requested_by,subject,year_levels,source_url)
  values(p_admin,s,y,case s when 'English' then 'https://f10.vcaa.vic.edu.au/learning-areas/english/english/curriculum' when 'Mathematics' then 'https://f10.vcaa.vic.edu.au/learning-areas/mathematics/curriculum' else 'https://f10.vcaa.vic.edu.au/learning-areas/science/curriculum' end) returning id into j;
  insert into public.admin_audit_log(admin_id,action,target_id,details) values(p_admin,'source_import.queued',j::text,jsonb_build_object('subject',s,'years',y));
  queued=queued+1;
 end loop;
 return jsonb_build_object('queued',queued,'already_active',active);
end $$;

create function public.admin_claim_curriculum_import(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.curriculum_source_imports; l uuid=gen_random_uuid(); begin
 update public.curriculum_source_imports set status='failed',error='Import retry limit reached',finished_at=now() where status='running' and lease_until<now() and attempts>=3;
 select * into j from public.curriculum_source_imports where (p_id is null or id=p_id) and attempts<3 and (status='queued' or (status='running' and lease_until<now())) order by created_at for update skip locked limit 1;
 if j.id is null then return null; end if;
 update public.curriculum_source_imports set status='running',lease_id=l,lease_until=now()+interval '2 minutes',attempts=attempts+1,error=null where id=j.id;
 return to_jsonb(j)||jsonb_build_object('lease_id',l);
end $$;

create function public.admin_finish_curriculum_import(p_id uuid,p_lease uuid,p_provenance jsonb,p_units jsonb,p_error text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.curriculum_source_imports; u jsonb; found_id uuid; prior_id uuid; change text; n integer=0; same integer=0; revised integer=0; missing integer=0; begin
 select * into j from public.curriculum_source_imports where id=p_id for update;
 if j.id is null or j.status<>'running' or j.lease_id is distinct from p_lease then return jsonb_build_object('status',coalesce(j.status,'missing')); end if;
 if p_error is not null then
  update public.curriculum_source_imports set status='failed',error=left(p_error,2000),finished_at=now(),lease_until=null where id=p_id;
  return jsonb_build_object('status','failed');
 end if;
 if p_provenance is null or p_provenance->>'source_url' is distinct from j.source_url or coalesce(p_provenance->>'source_sha256','') !~ '^[a-f0-9]{64}$' then raise exception 'Invalid source provenance'; end if;
 if p_units is null or jsonb_typeof(p_units)<>'array' or jsonb_array_length(p_units) not between 1 and 500 then raise exception 'Invalid import records'; end if;
 perform pg_advisory_xact_lock(91824712);
 select count(*) into missing from (select distinct cu.year_level,cu.descriptor_code from public.curriculum_units cu where cu.subject=j.subject and cu.year_level=any(j.year_levels) and cu.source_import_id is not null and not exists(select 1 from jsonb_array_elements(p_units) x where (x->>'year_level')::integer=cu.year_level and x->>'descriptor_code'=cu.descriptor_code)) m;
 update public.curriculum_units set source_current=false where subject=j.subject and year_level=any(j.year_levels) and source_import_id is not null;
 for u in select value from jsonb_array_elements(p_units) loop
  if not (u->>'year_level')::integer=any(j.year_levels) or coalesce(u->>'source_record_hash','') !~ '^[a-f0-9]{64}$' or coalesce(u->>'descriptor_code','')='' or coalesce(u->>'descriptor_text','')='' then raise exception 'Invalid curriculum reference'; end if;
  found_id=null;prior_id=null;
  select id into found_id from public.curriculum_units where subject=j.subject and year_level=(u->>'year_level')::integer and curriculum_version='Victorian Curriculum F-10 Version 2.0' and descriptor_code=u->>'descriptor_code' and source_record_hash=u->>'source_record_hash' and source_import_id is not null;
  if found_id is not null then same=same+1;change='unchanged';
  else
   select id into prior_id from public.curriculum_units where subject=j.subject and year_level=(u->>'year_level')::integer and curriculum_version='Victorian Curriculum F-10 Version 2.0' and descriptor_code=u->>'descriptor_code' and source_import_id is not null order by created_at desc,id limit 1;
   insert into public.curriculum_units(title,subject,year_level,curriculum_version,source_url,descriptor_code,descriptor_text,created_by,source_import_id,source_record_hash,source_details,supersedes_unit_id)
   values(u->>'title',j.subject,(u->>'year_level')::integer,'Victorian Curriculum F-10 Version 2.0',j.source_url,u->>'descriptor_code',u->>'descriptor_text',j.requested_by,j.id,u->>'source_record_hash',u->'source_details',prior_id) returning id into found_id;
   if prior_id is null then n=n+1;change='created';else revised=revised+1;change='revised';end if;
  end if;
  update public.curriculum_units set source_current=true,source_last_seen_import_id=j.id where id=found_id;
  insert into public.curriculum_import_items(import_id,unit_id,change_type) values(j.id,found_id,change);
 end loop;
 update public.curriculum_source_imports set status='completed',finished_at=now(),lease_until=null,
  source_sha256=p_provenance->>'source_sha256',source_fetched_at=(p_provenance->>'source_fetched_at')::timestamptz,source_bytes=(p_provenance->>'source_bytes')::integer,
  source_etag=p_provenance->>'source_etag',source_last_modified=p_provenance->>'source_last_modified',source_build_id=p_provenance->>'source_build_id',parser_version=p_provenance->>'parser_version',
  source_archive_base64=p_provenance->>'source_archive_base64',attribution=p_provenance->>'attribution',licence_url=p_provenance->>'licence_url',
  summary=jsonb_build_object('created',n,'unchanged',same,'revised',revised,'not_present',missing,'total',n+same+revised) where id=j.id;
 insert into public.admin_audit_log(admin_id,action,target_id,details) values(j.requested_by,'source_import.completed',j.id::text,jsonb_build_object('created',n,'unchanged',same,'revised',revised));
 return jsonb_build_object('status','completed','created',n,'unchanged',same,'revised',revised);
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_queue_curriculum_import','admin_claim_curriculum_import','admin_finish_curriculum_import') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
