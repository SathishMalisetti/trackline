-- Apply after schema.sql and curriculum-import.sql. No family data changes.
begin;
alter table public.curriculum_units drop constraint curriculum_units_year_level_check;
alter table public.curriculum_units add constraint curriculum_units_year_level_check check(year_level in (-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,101));
alter table public.curriculum_source_imports drop constraint curriculum_source_imports_year_levels_check;
alter table public.curriculum_source_imports add constraint curriculum_source_imports_year_levels_check check(cardinality(year_levels) between 1 and 16 and year_levels <@ array[-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,101] and array_position(year_levels,null) is null);
create or replace function public.admin_queue_curriculum_import(p_admin uuid,p_subjects text[],p_years integer[]) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s text; y integer[]; skipped integer=0; j uuid; queued integer=0; active integer=0; begin
 if cardinality(p_subjects) not between 1 and 3 or p_subjects is null or not p_subjects <@ array['Mathematics','English','Science'] or array_position(p_subjects,null) is not null then raise exception 'Select supported subjects'; end if;
 if p_years is null or cardinality(p_years) not between 1 and 16 or not p_years <@ array[-4,-3,-2,-1,0,1,2,3,4,5,6,7,8,9,10,101] or array_position(p_years,null) is not null then raise exception 'Select supported curriculum levels'; end if;
 perform pg_advisory_xact_lock(91824712);
 for s in select distinct v from unnest(p_subjects) v loop
  select array_agg(distinct v order by v) into y from unnest(p_years) v where s='Mathematics' or (s='English' and v<>101) or (s='Science' and v between 0 and 10);
  skipped=skipped+cardinality(p_years)-coalesce(cardinality(y),0);
  if y is null then continue; end if;
  if exists(select 1 from public.curriculum_source_imports where subject=s and status in ('queued','running')) then active=active+1; continue; end if;
  insert into public.curriculum_source_imports(requested_by,subject,year_levels,source_url)
  values(p_admin,s,y,case s when 'English' then 'https://f10.vcaa.vic.edu.au/learning-areas/english/english/curriculum' when 'Mathematics' then 'https://f10.vcaa.vic.edu.au/learning-areas/mathematics/curriculum' else 'https://f10.vcaa.vic.edu.au/learning-areas/science/curriculum' end) returning id into j;
  insert into public.admin_audit_log(admin_id,action,target_id,details) values(p_admin,'source_import.queued',j::text,jsonb_build_object('subject',s,'years',y));
  queued=queued+1;
 end loop;
 return jsonb_build_object('queued',queued,'already_active',active,'unavailable_combinations',skipped);
end $$;

revoke all on function public.admin_queue_curriculum_import(uuid,text[],integer[]) from public,anon,authenticated;
grant execute on function public.admin_queue_curriculum_import(uuid,text[],integer[]) to service_role;
commit;
