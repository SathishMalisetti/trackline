-- Requires Trackline's existing relational tables and RPCs.
begin;
create table public.family_auth_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  family_id text not null references public.families(id) on delete cascade,
  member_id text not null references public.members(id) on delete cascade,
  role text not null check (role in ('parent', 'kid')),
  primary key (user_id, family_id),
  unique (family_id, member_id)
);
create index family_auth_memberships_family_idx on public.family_auth_memberships(family_id);
alter table public.family_auth_memberships enable row level security;
revoke all on public.family_auth_memberships from anon, authenticated;
grant select on public.family_auth_memberships to authenticated;
grant all on public.family_auth_memberships to service_role;
create policy account_reads_own_memberships on public.family_auth_memberships
  for select to authenticated using ((select auth.uid()) = user_id);

-- Only server-side APIs access application tables. Keep rows and policies intact.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'families','members','events','chores','chore_logs','shopping_lists',
    'shopping_items','shopping_item_library','chore_library','activity_library',
    'chore_library_items','quick_list_items','shopping_item_library_items',
    'devices','usage','device_usage','subjects','subject_levels','topics',
    'question_bank','exam_attempts','exam_answers','topic_progress','study_assignments','school_term_dates'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
      execute format('grant all on table public.%I to service_role', table_name);
    end if;
  end loop;
end $$;

-- Remove the default public execute grant on privileged application RPCs.
do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('get_family_data','save_family_data')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end $$;
commit;
