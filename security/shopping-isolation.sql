-- Atomic upsert: a lookup before an unscoped REST upsert is not sufficient.
create or replace function public.save_shopping_trip(p_family_id text, p_trip jsonb)
returns void language plpgsql security invoker set search_path = ''
as $$
declare affected integer;
begin
  insert into public.shopping_lists(id, family_id, date, data, updated_at)
  values (p_trip->>'id', p_family_id, nullif(p_trip->>'date','')::date, p_trip, now())
  on conflict(id) do update set
    date = excluded.date, data = excluded.data, updated_at = excluded.updated_at
  where shopping_lists.family_id = p_family_id;
  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception using errcode = '42501', message = 'Record does not belong to this family.';
  end if;
end;
$$;
revoke all on function public.save_shopping_trip(text,jsonb) from public, anon, authenticated;
grant execute on function public.save_shopping_trip(text,jsonb) to service_role;
