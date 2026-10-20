-- Additive background reminders. Existing schedules, authentication and save RPCs are unchanged.
begin;
create table public.push_config (
 id boolean primary key default true check(id),
 public_key text, private_key text,
 worker_secret text not null default replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),
 app_origin text not null default 'https://victorious-field-093009200.7.azurestaticapps.net',
 enabled boolean not null default true
);
insert into public.push_config(id) values(true);
create table public.push_subscriptions (
 id uuid primary key default gen_random_uuid(), endpoint text not null unique, keys jsonb not null,
 device_key_hash text not null check(device_key_hash ~ '^[a-f0-9]{64}$'),
 family_id text not null references public.families(id) on delete cascade,
 member_id text not null references public.members(id) on delete cascade,
 session_hash text references public.family_device_sessions(token_hash) on delete cascade,
 auth_user_id uuid, enabled boolean not null default true,
 minutes_before integer not null default 15 check(minutes_before between 1 and 1440),
 child_ids text[] not null default '{}', timezone text not null,
 expires_at timestamptz not null, updated_at timestamptz not null default now(),
 check((session_hash is null) <> (auth_user_id is null))
);
create index push_subscription_member on public.push_subscriptions(member_id);
create index push_subscription_session on public.push_subscriptions(session_hash);
create index push_subscription_family on public.push_subscriptions(family_id);
create index push_subscription_active on public.push_subscriptions(id) where enabled;
create table public.push_item_mutes (
 subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
 kind text not null check(kind in ('event','task')), item_id text not null,
 primary key(subscription_id,kind,item_id)
);
create table public.push_deliveries (
 subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
 delivery_key text not null, status text not null check(status in ('sending','sent','failed')),
 attempts integer not null default 1, lease_id uuid not null, lease_until timestamptz not null,
 error_code text, updated_at timestamptz not null default now(),
 primary key(subscription_id,delivery_key)
);
create index push_delivery_cleanup on public.push_deliveries(updated_at);
do $$ declare t text; begin
 foreach t in array array['push_config','push_subscriptions','push_item_mutes','push_deliveries'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;
create function public.push_initialise_keys(p_public text,p_private text) returns void
language sql security invoker set search_path='' as $$
 update public.push_config set public_key=p_public,private_key=p_private where id and public_key is null;
$$;
create function public.push_subscription_active(s public.push_subscriptions) returns boolean
language sql stable security invoker set search_path='' as $$
 select s.enabled and s.expires_at>now() and exists (
  select 1 from public.members m where m.id=s.member_id and m.family_id=s.family_id and (
   (s.session_hash is not null and exists(select 1 from public.family_device_sessions d join public.families f on f.id=d.family_id
     where d.token_hash=s.session_hash and d.family_id=s.family_id and d.member_id=s.member_id and d.expires_at>now()
       and d.password_version=f.password_hash and d.pin_version=m.pin_hash))
   or (s.auth_user_id is not null and exists(select 1 from public.family_auth_memberships a
     where a.user_id=s.auth_user_id and a.family_id=s.family_id and a.member_id=s.member_id and a.role=m.role))
  )
 );
$$;
create function public.push_save_subscription(p_data jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
declare old public.push_subscriptions; result uuid; begin
 perform pg_advisory_xact_lock(hashtextextended(p_data->>'endpoint',71717));
 select * into old from public.push_subscriptions where endpoint=p_data->>'endpoint' for update;
 if old.id is not null and old.device_key_hash is distinct from p_data->>'device_key_hash' then raise exception using errcode='42501',message='Subscription belongs to another device'; end if;
 if not exists(select 1 from public.members where id=p_data->>'member_id' and family_id=p_data->>'family_id') then raise exception 'Invalid member'; end if;
 insert into public.push_subscriptions(endpoint,keys,device_key_hash,family_id,member_id,session_hash,auth_user_id,minutes_before,child_ids,timezone,expires_at)
 values(p_data->>'endpoint',p_data->'keys',p_data->>'device_key_hash',p_data->>'family_id',p_data->>'member_id',p_data->>'session_hash',(p_data->>'auth_user_id')::uuid,(p_data->>'minutes_before')::integer,
 array(select jsonb_array_elements_text(p_data->'child_ids')),p_data->>'timezone',(p_data->>'expires_at')::timestamptz)
 on conflict(endpoint) do update set keys=excluded.keys,family_id=excluded.family_id,member_id=excluded.member_id,session_hash=excluded.session_hash,auth_user_id=excluded.auth_user_id,
 enabled=true,minutes_before=excluded.minutes_before,child_ids=excluded.child_ids,timezone=excluded.timezone,expires_at=excluded.expires_at,updated_at=now() returning id into result;
 if old.id is not null and (old.member_id<>p_data->>'member_id' or old.family_id<>p_data->>'family_id') then delete from public.push_item_mutes where subscription_id=result; end if;
 return result;
end $$;
create function public.push_live_subscriptions(p_after uuid,p_limit integer) returns setof public.push_subscriptions
language sql stable security invoker set search_path='' as $$
 select s.* from public.push_subscriptions s where (p_after is null or s.id>p_after) and public.push_subscription_active(s) order by s.id limit least(greatest(p_limit,1),100);
$$;
create function public.push_claim_delivery(p_id uuid,p_key text,p_kind text,p_item text,p_date date,p_minutes integer) returns uuid
language plpgsql security invoker set search_path='' as $$
declare result uuid; begin
 if not exists(select 1 from public.push_subscriptions s where s.id=p_id and s.minutes_before=p_minutes and public.push_subscription_active(s))
 or exists(select 1 from public.push_item_mutes where subscription_id=p_id and kind=p_kind and item_id=p_item)
 or (p_kind='task' and exists(select 1 from public.chore_logs l join public.push_subscriptions s on s.family_id=l.family_id where s.id=p_id and l.chore_id=p_item and l.date=p_date)) then return null; end if;
 insert into public.push_deliveries(subscription_id,delivery_key,status,lease_id,lease_until)
 values(p_id,p_key,'sending',gen_random_uuid(),now()+interval '60 seconds')
 on conflict(subscription_id,delivery_key) do update set status='sending',attempts=push_deliveries.attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '60 seconds',updated_at=now()
 where push_deliveries.attempts<3 and (push_deliveries.status='failed' or (push_deliveries.status='sending' and push_deliveries.lease_until<now()))
 returning lease_id into result;
 return result;
end $$;
create function public.push_finish_delivery(p_id uuid,p_key text,p_lease uuid,p_sent boolean,p_error text) returns void
language sql security invoker set search_path='' as $$
 update public.push_deliveries set status=case when p_sent then 'sent' else 'failed' end,error_code=left(p_error,80),updated_at=now()
 where subscription_id=p_id and delivery_key=p_key and lease_id=p_lease and status='sending';
$$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'push_%' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
commit;
