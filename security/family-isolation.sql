CREATE OR REPLACE FUNCTION public.save_family_data_secure(p_family_id text, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = ''
AS $function$
declare
  affected integer;
begin
  insert into public.families (id, name, primary_holder_name, primary_holder_email, primary_holder_phone, password_hash, updated_at)
  values (
    p_family_id,
    p_data->'family'->>'name',
    p_data->'family'->>'primaryHolderName',
    p_data->'family'->>'primaryHolderEmail',
    p_data->'family'->>'primaryHolderPhone',
    p_data->'family'->>'passwordHash',
    now()
  )
  on conflict (id) do update set
    name = excluded.name,
    primary_holder_name = excluded.primary_holder_name,
    primary_holder_email = excluded.primary_holder_email,
    primary_holder_phone = excluded.primary_holder_phone,
    updated_at = now();

  -- Upsert, not delete-then-reinsert — a blanket DELETE here fails outright
  -- the moment any member has study_assignments/topic_progress/exam_attempts
  -- referencing them (foreign key violation, confirmed via a real error:
  -- Postgres 23503 on study_assignments_member_id_fkey), which rolls back
  -- the ENTIRE save, for every table, since this all runs as one
  -- transaction. Members still present in the payload are never deleted at
  -- all now, so that foreign key is never even touched for them.
  insert into public.members (id, family_id, name, role, color, pin_hash, email, phone, year_level, can_add_tasks, can_add_shopping)
  select
    m->>'id', p_family_id, m->>'name', m->>'role', m->>'color', null, m->>'email', m->>'phone',
    m->>'yearLevel',
    coalesce(nullif(m->>'canAddTasks','')::boolean, true),
    coalesce(nullif(m->>'canAddShopping','')::boolean, true)
  from jsonb_array_elements(coalesce(p_data->'members','[]'::jsonb)) as m
  on conflict (id) do update set
    name = excluded.name,
    role = excluded.role,
    color = excluded.color,
    email = excluded.email,
    phone = excluded.phone,
    year_level = excluded.year_level,
    can_add_tasks = excluded.can_add_tasks,
    can_add_shopping = excluded.can_add_shopping
  where members.family_id = p_family_id;
  get diagnostics affected = row_count;
  if affected <> jsonb_array_length(coalesce(p_data->'members', '[]'::jsonb)) then
    raise exception using errcode = '42501', message = 'Record does not belong to this family.';
  end if;

  -- Only genuinely-removed members get deleted — this can still legitimately
  -- fail with the same foreign key error, but only if someone is actually
  -- trying to remove a kid who has study history, which is a real, rarer
  -- case worth surfacing clearly rather than happening as a silent side
  -- effect of every unrelated save.
  delete from public.members
  where family_id = p_family_id
    and id not in (
      select coalesce(m->>'id','') from jsonb_array_elements(coalesce(p_data->'members','[]'::jsonb)) as m
    );

  -- Same upsert pattern as members — no confirmed foreign-key issue for
  -- events specifically yet, but this is the more robust pattern
  -- regardless: it means a FUTURE feature adding a reference to event ids
  -- can never reintroduce this exact class of bug silently.
  insert into public.events (id, family_id, member_id, title, recurrence, day, days, date, skip_dates, occurrence_overrides, start_min, end_min, location, notes, needs_drive, driver_id, travel_min, color, recurrence_end_date)
  select
    e->>'id', p_family_id, e->>'memberId', e->>'title', e->>'recurrence',
    coalesce(nullif(e->>'day',''), nullif(e->'days'->>0,''))::int,
    coalesce(e->'days', case when nullif(e->>'day','') is not null then jsonb_build_array((nullif(e->>'day',''))::int) else '[]'::jsonb end),
    nullif(e->>'date','')::date,
    coalesce(e->'skipDates','[]'::jsonb), coalesce(e->'occurrenceOverrides','[]'::jsonb),
    nullif(e->>'start','')::int, nullif(e->>'end','')::int,
    e->>'location', e->>'notes',
    coalesce(nullif(e->>'needsDrive','')::boolean,false), e->>'driverId', coalesce(nullif(e->>'travelMin','')::int,0),
    e->>'color',
    nullif(e->>'recurrenceEndDate','')::date
  from jsonb_array_elements(coalesce(p_data->'events','[]'::jsonb)) as e
  on conflict (id) do update set
    member_id = excluded.member_id, title = excluded.title, recurrence = excluded.recurrence,
    day = excluded.day, days = excluded.days, date = excluded.date,
    skip_dates = excluded.skip_dates, occurrence_overrides = excluded.occurrence_overrides,
    start_min = excluded.start_min, end_min = excluded.end_min,
    location = excluded.location, notes = excluded.notes,
    needs_drive = excluded.needs_drive, driver_id = excluded.driver_id, travel_min = excluded.travel_min,
    color = excluded.color, recurrence_end_date = excluded.recurrence_end_date
  where events.family_id = p_family_id;
  get diagnostics affected = row_count;
  if affected <> jsonb_array_length(coalesce(p_data->'events', '[]'::jsonb)) then
    raise exception using errcode = '42501', message = 'Record does not belong to this family.';
  end if;

  delete from public.events
  where family_id = p_family_id
    and id not in (
      select coalesce(e->>'id','') from jsonb_array_elements(coalesce(p_data->'events','[]'::jsonb)) as e
    );

  -- Same reasoning as members/events, arguably even more likely to matter
  -- here: chore_logs (completion history) almost certainly references
  -- chores.id, and tasks get completed constantly — this delete-then-
  -- reinsert could have been failing on nearly every save once any task
  -- had ever been marked done.
  insert into public.chores (id, family_id, member_id, title, frequency, days, day_of_month, start_date, due_date, due_time, points, active, pending_approval, icon)
  select
    c->>'id', p_family_id, c->>'memberId', c->>'title', c->>'frequency',
    coalesce(c->'days','[]'::jsonb), nullif(c->>'dayOfMonth','')::int,
    nullif(c->>'startDate','')::date, nullif(c->>'dueDate','')::date, c->>'dueTime',
    coalesce(nullif(c->>'points','')::int,0), coalesce(nullif(c->>'active','')::boolean,true),
    coalesce(nullif(c->>'pendingApproval','')::boolean, false),
    c->>'icon'
  from jsonb_array_elements(coalesce(p_data->'chores','[]'::jsonb)) as c
  on conflict (id) do update set
    member_id = excluded.member_id, title = excluded.title, frequency = excluded.frequency,
    days = excluded.days, day_of_month = excluded.day_of_month,
    start_date = excluded.start_date, due_date = excluded.due_date, due_time = excluded.due_time,
    points = excluded.points, active = excluded.active,
    pending_approval = excluded.pending_approval, icon = excluded.icon
  where chores.family_id = p_family_id;
  get diagnostics affected = row_count;
  if affected <> jsonb_array_length(coalesce(p_data->'chores', '[]'::jsonb)) then
    raise exception using errcode = '42501', message = 'Record does not belong to this family.';
  end if;

  delete from public.chores
  where family_id = p_family_id
    and id not in (
      select coalesce(c->>'id','') from jsonb_array_elements(coalesce(p_data->'chores','[]'::jsonb)) as c
    );

  delete from public.chore_library_items where family_id = p_family_id;
  insert into public.chore_library_items (family_id, title)
  select p_family_id, x from jsonb_array_elements_text(coalesce(p_data->'choreLibrary','[]'::jsonb)) as x
  on conflict do nothing;

  -- Same upsert pattern applied consistently, closing off the same class
  -- of risk everywhere rather than leaving this one table as the sole
  -- exception.
  insert into public.quick_list_items (id, family_id, name, added_by)
  select i->>'id', p_family_id, i->>'name', i->>'addedBy'
  from jsonb_array_elements(coalesce(p_data->'shoppingList','[]'::jsonb)) as i
  on conflict (id) do update set
    name = excluded.name, added_by = excluded.added_by
  where quick_list_items.family_id = p_family_id;
  get diagnostics affected = row_count;
  if affected <> jsonb_array_length(coalesce(p_data->'shoppingList', '[]'::jsonb)) then
    raise exception using errcode = '42501', message = 'Record does not belong to this family.';
  end if;

  delete from public.quick_list_items
  where family_id = p_family_id
    and id not in (
      select coalesce(i->>'id','') from jsonb_array_elements(coalesce(p_data->'shoppingList','[]'::jsonb)) as i
    );

  delete from public.shopping_item_library_items where family_id = p_family_id;
  insert into public.shopping_item_library_items (family_id, name)
  select p_family_id, x from jsonb_array_elements_text(coalesce(p_data->'shoppingItemLibrary','[]'::jsonb)) as x
  on conflict do nothing;
end;
$function$;

revoke all on function public.save_family_data_secure(text,jsonb) from public, anon, authenticated;
grant execute on function public.save_family_data_secure(text,jsonb) to service_role;

