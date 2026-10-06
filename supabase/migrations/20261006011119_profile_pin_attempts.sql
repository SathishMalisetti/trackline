begin;
alter table public.members add column pin_failed_attempts integer not null default 0;
alter table public.members add column pin_locked_until timestamptz;
create function public.check_profile_pin_attempt(p_member_id text, p_family_id text, p_observed_hash text, p_matches boolean, p_new_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare profile public.members%rowtype; wait_seconds integer;
begin
  select * into profile from public.members where id = p_member_id and family_id = p_family_id for update;
  if not found then return pg_catalog.jsonb_build_object('status',403,'error','Profile not found.'); end if;
  if profile.pin_hash is distinct from p_observed_hash then
    return pg_catalog.jsonb_build_object('status',409,'error','Your PIN changed. Refresh and try again.');
  end if;
  if profile.pin_hash is not null and profile.pin_locked_until > pg_catalog.now() then
    wait_seconds := ceil(extract(epoch from profile.pin_locked_until - pg_catalog.now()));
    return pg_catalog.jsonb_build_object('status',429,'error','Too many incorrect attempts. Try again in ' || wait_seconds || ' seconds.');
  end if;
  if p_matches then
    if profile.pin_hash is null and p_new_hash is null then raise exception 'New PIN hash required'; end if;
    update public.members set pin_hash = coalesce(p_new_hash, pin_hash), pin_failed_attempts = 0, pin_locked_until = null where id = p_member_id;
    return pg_catalog.jsonb_build_object('status',200,'ok',true);
  end if;
  update public.members set pin_failed_attempts = pin_failed_attempts + 1,
    pin_locked_until = case when pin_failed_attempts + 1 >= 5 then pg_catalog.now() + interval '30 seconds' else null end
    where id = p_member_id;
  return pg_catalog.jsonb_build_object('status',403,'error','Incorrect PIN. Please try again.');
end;
$$;
revoke all on function public.check_profile_pin_attempt(text,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.check_profile_pin_attempt(text,text,text,boolean,text) to service_role;
commit;
