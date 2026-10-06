begin;
-- Only the authenticated Azure API can call this RPC. It supplies the verified
-- account ID, never an ID or role chosen by the browser.
create function public.create_family_for_account(p_user_id uuid, p_email text, p_family_name text, p_parent_name text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  existing public.family_auth_memberships%rowtype;
  family_id text;
  member_id text;
begin
  if p_user_id is null or p_email is null or btrim(p_email) = ''
    or p_family_name is null or length(btrim(p_family_name)) not between 1 and 80
    or p_parent_name is null or length(btrim(p_parent_name)) not between 1 and 80 then
    raise exception 'Invalid family setup details' using errcode = '22023';
  end if;
  -- Serialize concurrent submissions and retries for this account.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  select * into existing from public.family_auth_memberships m
    where m.user_id = p_user_id order by m.family_id limit 1;
  if found then
    return pg_catalog.jsonb_build_object('family_id', existing.family_id, 'member_id', existing.member_id, 'role', existing.role);
  end if;
  family_id := upper(replace(pg_catalog.gen_random_uuid()::text, '-', ''));
  member_id := pg_catalog.gen_random_uuid()::text;
  insert into public.families(id, name, primary_holder_name, primary_holder_email)
    values (family_id, btrim(p_family_name), btrim(p_parent_name), p_email);
  insert into public.members(id, family_id, name, role, color, email)
    values (member_id, family_id, btrim(p_parent_name), 'parent', '#4C8577', p_email);
  insert into public.family_auth_memberships(user_id, family_id, member_id, role)
    values (p_user_id, family_id, member_id, 'parent');
  return pg_catalog.jsonb_build_object('family_id', family_id, 'member_id', member_id, 'role', 'parent');
end;
$$;
revoke all on function public.create_family_for_account(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.create_family_for_account(uuid,text,text,text) to service_role;
commit;
