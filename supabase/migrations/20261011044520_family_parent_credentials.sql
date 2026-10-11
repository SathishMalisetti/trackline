begin;
-- Separate personal parent credentials; family passwords and existing sessions stay intact.
create table public.parent_credentials (
  member_id text primary key references public.members(id) on delete cascade,
  password_hash text not null check(password_hash ~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$'),
  failed_attempts integer not null default 0,
  locked_until timestamptz
);
alter table public.parent_credentials enable row level security;
revoke all on public.parent_credentials from public,anon,authenticated;
grant all on public.parent_credentials to service_role;

create function public.register_family_with_parent(p_username text,p_family_name text,p_parent_name text,p_family_hash text,p_family_legacy text,p_parent_hash text,p_pin_hash text,p_token_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; parent_id text;
begin
  if p_parent_hash is null or p_parent_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$' or p_pin_hash is null or p_pin_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$' then raise exception 'Invalid parent credentials'; end if;
  result := public.register_family_credentials(p_username,p_family_name,p_parent_name,p_family_hash,p_family_legacy,p_token_hash);
  parent_id := result->>'memberId';
  insert into public.parent_credentials(member_id,password_hash) values(parent_id,p_parent_hash);
  update public.members set pin_hash=p_pin_hash where id=parent_id;
  update public.family_device_sessions set member_id=parent_id,pin_version=p_pin_hash,bootstrap_member_id=null,setup_completed=true where token_hash=p_token_hash;
  return result;
end;
$$;

create function public.check_parent_password(p_token_hash text,p_member_id text,p_observed_hash text,p_matches boolean)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare device public.family_device_sessions%rowtype; profile public.members%rowtype; credential public.parent_credentials%rowtype;
begin
  select * into device from public.family_device_sessions where token_hash=p_token_hash and expires_at>pg_catalog.now() for update;
  if not found or not exists(select 1 from public.families where id=device.family_id and password_hash=device.password_version) then return jsonb_build_object('status',401,'error','Access your family again.'); end if;
  select * into profile from public.members where id=p_member_id and family_id=device.family_id and role='parent' for update;
  if not found then return jsonb_build_object('status',403,'error','Parent profile required.'); end if;
  select * into credential from public.parent_credentials where member_id=p_member_id for update;
  if not found or credential.password_hash is distinct from p_observed_hash then return jsonb_build_object('status',403,'error','Parent password unavailable. Use your PIN, or ask a parent to set a password in Settings.'); end if;
  if credential.locked_until>pg_catalog.now() then return jsonb_build_object('status',429,'error','Too many attempts. Try again in 30 seconds.'); end if;
  if p_matches is not true then
    update public.parent_credentials set failed_attempts=failed_attempts+1,locked_until=case when failed_attempts+1>=5 then pg_catalog.now()+interval '30 seconds' else null end where member_id=p_member_id;
    return jsonb_build_object('status',403,'error','Incorrect parent password.');
  end if;
  update public.parent_credentials set failed_attempts=0,locked_until=null where member_id=p_member_id;
  -- A password-verified parent without a PIN may establish their own PIN.
  update public.family_device_sessions set member_id=case when profile.pin_hash is not null then profile.id else null end,pin_version=profile.pin_hash,bootstrap_member_id=case when profile.pin_hash is null then profile.id else null end,setup_completed=true where token_hash=p_token_hash;
  return jsonb_build_object('status',200,'needsPin',profile.pin_hash is null);
end;
$$;

create function public.set_parent_password(p_family_id text,p_member_id text,p_password_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  -- API verifies an unlocked parent membership before invoking this service-only RPC.
  if p_password_hash is null or p_password_hash !~ '^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$' or not exists(select 1 from public.members where id=p_member_id and family_id=p_family_id and role='parent') then return jsonb_build_object('status',403,'error','Parent profile required.'); end if;
  insert into public.parent_credentials(member_id,password_hash) values(p_member_id,p_password_hash) on conflict(member_id) do update set password_hash=excluded.password_hash,failed_attempts=0,locked_until=null;
  return jsonb_build_object('status',200,'ok',true);
end;
$$;

create or replace function public.unlock_family_profile(p_token_hash text,p_member_id text,p_observed_hash text,p_matches boolean,p_new_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare device public.family_device_sessions%rowtype; profile public.members%rowtype; outcome jsonb;
begin
  select * into device from public.family_device_sessions where token_hash=p_token_hash and expires_at>pg_catalog.now() for update;
  if not found or not exists(select 1 from public.families where id=device.family_id and password_hash=device.password_version) then return jsonb_build_object('status',401,'error','Sign in to your family again.'); end if;
  select * into profile from public.members where id=p_member_id and family_id=device.family_id for update;
  if not found then return jsonb_build_object('status',403,'error','Profile does not belong to this family.'); end if;
  if profile.role='parent' and profile.pin_hash is null and device.bootstrap_member_id is distinct from profile.id then return jsonb_build_object('status',403,'error','Verify this parent with their personal password before setting their PIN.'); end if;
  outcome := public.check_profile_pin_attempt(profile.id,device.family_id,p_observed_hash,p_matches,p_new_hash);
  if (outcome->>'status')::int=200 then update public.family_device_sessions set member_id=profile.id,pin_version=(select pin_hash from public.members where id=profile.id),bootstrap_member_id=null where token_hash=p_token_hash; end if;
  return outcome;
end;
$$;
revoke all on function public.register_family_with_parent(text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.check_parent_password(text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.set_parent_password(text,text,text) from public,anon,authenticated;
grant execute on function public.register_family_with_parent(text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.check_parent_password(text,text,text,boolean) to service_role;
grant execute on function public.set_parent_password(text,text,text) to service_role;
commit;
