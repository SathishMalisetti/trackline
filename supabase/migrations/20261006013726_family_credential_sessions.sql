begin;
alter table public.families add column login_username text unique;
alter table public.families add column login_password_hash text;
alter table public.families add column login_password_version text;
alter table public.families add column login_failed_attempts integer not null default 0;
alter table public.families add column login_locked_until timestamptz;
create table public.family_device_sessions (
  token_hash text primary key,
  family_id text not null references public.families(id) on delete cascade,
  member_id text references public.members(id) on delete cascade,
  bootstrap_member_id text references public.members(id) on delete cascade,
  password_version text not null,
  pin_version text,
  setup_completed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);
create index family_device_sessions_family_idx on public.family_device_sessions(family_id);
create index family_device_sessions_member_idx on public.family_device_sessions(member_id);
create index family_device_sessions_bootstrap_idx on public.family_device_sessions(bootstrap_member_id);
alter table public.family_device_sessions enable row level security;
revoke all on public.family_device_sessions from public, anon, authenticated;
grant all on public.family_device_sessions to service_role;

create function public.register_family_credentials(p_username text,p_family_name text,p_parent_name text,p_password_hash text,p_legacy_hash text,p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_family text := upper(replace(pg_catalog.gen_random_uuid()::text,'-','')); v_member text := pg_catalog.gen_random_uuid()::text;
begin
  if p_username is null or p_username !~ '^[a-z][a-z0-9_-]{2,31}$'
    or p_family_name is null or length(btrim(p_family_name)) not between 1 and 80
    or p_parent_name is null or length(btrim(p_parent_name)) not between 1 and 80
    or p_password_hash is null or p_password_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$'
    or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_legacy_hash is null then raise exception 'Invalid registration'; end if;
  insert into public.families(id,name,primary_holder_name,password_hash,login_username,login_password_hash,login_password_version)
    values(v_family,btrim(p_family_name),btrim(p_parent_name),p_legacy_hash,p_username,p_password_hash,p_legacy_hash);
  insert into public.members(id,family_id,name,role,color) values(v_member,v_family,btrim(p_parent_name),'parent','#4C8577');
  insert into public.family_device_sessions(token_hash,family_id,bootstrap_member_id,password_version) values(p_token_hash,v_family,v_member,p_legacy_hash);
  return pg_catalog.jsonb_build_object('status',200,'familyId',v_family,'memberId',v_member);
end;
$$;
create function public.check_family_login_attempt(p_family_id text,p_observed_hash text,p_matches boolean,p_secure_hash text,p_token_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare fam public.families%rowtype;
begin
  select * into fam from public.families where id=p_family_id for update;
  if not found or fam.password_hash is null or fam.password_hash is distinct from p_observed_hash then
    return pg_catalog.jsonb_build_object('status',403,'error','Incorrect family ID, username or password.'); end if;
  if fam.login_locked_until > pg_catalog.now() then return pg_catalog.jsonb_build_object('status',429,'error','Too many attempts. Try again in 30 seconds.'); end if;
  if p_matches is not true then
    update public.families set login_failed_attempts=login_failed_attempts+1,
      login_locked_until=case when login_failed_attempts+1>=5 then pg_catalog.now()+interval '30 seconds' else null end where id=p_family_id;
    return pg_catalog.jsonb_build_object('status',403,'error','Incorrect family ID, username or password.');
  end if;
  update public.families set login_password_hash=coalesce(p_secure_hash,login_password_hash),login_password_version=password_hash,login_failed_attempts=0,login_locked_until=null where id=p_family_id;
  insert into public.family_device_sessions(token_hash,family_id,password_version) values(p_token_hash,p_family_id,fam.password_hash);
  return pg_catalog.jsonb_build_object('status',200,'familyId',p_family_id);
end;
$$;
create function public.unlock_family_profile(p_token_hash text,p_member_id text,p_observed_hash text,p_matches boolean,p_new_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare device public.family_device_sessions%rowtype; profile public.members%rowtype; outcome jsonb;
begin
  select * into device from public.family_device_sessions where token_hash=p_token_hash and expires_at>pg_catalog.now() for update;
  if not found or not exists(select 1 from public.families where id=device.family_id and password_hash=device.password_version) then
    return pg_catalog.jsonb_build_object('status',401,'error','Sign in to your family again.'); end if;
  select * into profile from public.members where id=p_member_id and family_id=device.family_id for update;
  if not found then return pg_catalog.jsonb_build_object('status',403,'error','Profile does not belong to this family.'); end if;
  outcome := public.check_profile_pin_attempt(profile.id,device.family_id,p_observed_hash,p_matches,p_new_hash);
  if (outcome->>'status')::int=200 then
    update public.family_device_sessions set member_id=profile.id,pin_version=(select pin_hash from public.members where id=profile.id),bootstrap_member_id=null where token_hash=p_token_hash;
  end if;
  return outcome;
end;
$$;
create function public.setup_registered_family(p_token_hash text,p_parent_name text,p_members jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare device public.family_device_sessions%rowtype; entry jsonb;
begin
  select * into device from public.family_device_sessions where token_hash=p_token_hash and expires_at>pg_catalog.now() for update;
  if not found or device.bootstrap_member_id is null or not exists(select 1 from public.families where id=device.family_id and password_hash=device.password_version) then
    return pg_catalog.jsonb_build_object('status',403,'error','Initial setup is available only on the registration device.'); end if;
  if device.setup_completed then return pg_catalog.jsonb_build_object('status',200,'ok',true); end if;
  if p_parent_name is null or length(btrim(p_parent_name)) not between 1 and 80 or p_members is null or jsonb_typeof(p_members)<>'array' or jsonb_array_length(p_members)>20 then raise exception 'Invalid setup'; end if;
  if not exists(select 1 from public.members where id=device.bootstrap_member_id and family_id=device.family_id and role='parent' and pin_hash is null) then
    return pg_catalog.jsonb_build_object('status',403,'error','Initial setup is already complete. Use Settings to change family members.'); end if;
  update public.members set name=btrim(p_parent_name) where id=device.bootstrap_member_id;
  update public.families set primary_holder_name=btrim(p_parent_name) where id=device.family_id;
  for entry in select value from jsonb_array_elements(p_members) loop
    if entry->>'role' is null or entry->>'role' not in ('parent','kid') or entry->>'name' is null or length(btrim(entry->>'name')) not between 1 and 80 then raise exception 'Invalid member'; end if;
    insert into public.members(id,family_id,name,role,color) values(pg_catalog.gen_random_uuid()::text,device.family_id,btrim(entry->>'name'),entry->>'role',case when entry->>'role'='parent' then '#C1555F' else '#CE8A2E' end);
  end loop;
  update public.family_device_sessions set setup_completed=true where token_hash=p_token_hash;
  return pg_catalog.jsonb_build_object('status',200,'ok',true);
end;
$$;
revoke all on function public.setup_registered_family(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.setup_registered_family(text,text,jsonb) to service_role;
revoke all on function public.register_family_credentials(text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.check_family_login_attempt(text,text,boolean,text,text) from public,anon,authenticated;
revoke all on function public.unlock_family_profile(text,text,text,boolean,text) from public,anon,authenticated;
grant execute on function public.register_family_credentials(text,text,text,text,text,text) to service_role;
grant execute on function public.check_family_login_attempt(text,text,boolean,text,text) to service_role;
grant execute on function public.unlock_family_profile(text,text,text,boolean,text) to service_role;
commit;
