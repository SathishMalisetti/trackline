-- Only the protected server endpoint may update these credentials.
create or replace function public.set_family_password_secure(p_family_id text,p_hash text,p_version text,p_token_hash text)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  update public.families set password_hash=p_version, login_password_hash=p_hash,
    login_password_version=p_version where id=p_family_id;
  delete from public.family_device_sessions where family_id=p_family_id and token_hash is distinct from p_token_hash;
  update public.family_device_sessions set password_version=p_version where family_id=p_family_id and token_hash=p_token_hash;
end;
$$;
revoke all on function public.set_family_password_secure(text,text,text,text) from public,anon,authenticated;
grant execute on function public.set_family_password_secure(text,text,text,text) to service_role;

-- Public schema is trusted: anon/authenticated must not create shadow objects.
revoke create on schema public from public,anon,authenticated;
alter function public.get_family_data(text) set search_path = public, pg_temp;
alter function public.family_id() set search_path = '';
