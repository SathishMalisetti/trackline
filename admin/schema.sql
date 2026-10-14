-- Platform administration is independent of family membership.
create table public.platform_admins (
 id uuid primary key default gen_random_uuid(), username text not null unique check(username ~ '^[a-z][a-z0-9_-]{2,31}$'),
 password_hash text not null check(password_hash like 'scrypt:%'), pin_hash text not null check(pin_hash like 'scrypt:%'),
 enabled boolean not null default true, credential_version uuid not null default gen_random_uuid(),
 password_failures integer not null default 0, pin_failures integer not null default 0, locked_until timestamptz,
 created_at timestamptz not null default now()
);
create table public.platform_admin_sessions (
 token_hash text primary key, admin_id uuid not null references public.platform_admins(id) on delete cascade,
 credential_version uuid not null, expires_at timestamptz not null default now()+interval '30 days',
 unlocked_until timestamptz, password_verified_at timestamptz not null default now()
);
create index admin_session_account on public.platform_admin_sessions(admin_id);
create table public.admin_audit_log (
 id uuid primary key default gen_random_uuid(), admin_id uuid references public.platform_admins(id),
 action text not null, target_id text, details jsonb not null default '{}', created_at timestamptz not null default now()
);
create table public.curriculum_units (
 id uuid primary key default gen_random_uuid(), title text not null, subject text not null check(subject in ('Mathematics','English','Science')),
 year_level integer not null check(year_level in (4,7)), curriculum_version text not null default 'Victorian Curriculum F-10 Version 2.0',
 source_url text not null, descriptor_code text not null, descriptor_text text not null,
 archived boolean not null default false, created_by uuid references public.platform_admins(id), created_at timestamptz not null default now()
);
create table public.curriculum_content_versions (
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references public.curriculum_units(id), version integer not null,
 status text not null default 'draft' check(status in ('draft','validated','published','archived')),
 content jsonb not null, review_notes text not null default '', created_by uuid references public.platform_admins(id),
 created_at timestamptz not null default now(), published_at timestamptz, unique(unit_id,version)
);
create unique index one_published_unit_version on public.curriculum_content_versions(unit_id) where status='published';
create table public.curriculum_generation_jobs (
 id uuid primary key default gen_random_uuid(), unit_id uuid not null references public.curriculum_units(id),
 created_by uuid not null references public.platform_admins(id), status text not null default 'queued' check(status in ('queued','running','completed','failed','cancelled')),
 lease_id uuid, lease_until timestamptz, attempts integer not null default 0, error text,
 result_version_id uuid references public.curriculum_content_versions(id), created_at timestamptz not null default now(), finished_at timestamptz
);
create unique index one_active_generation_unit on public.curriculum_generation_jobs(unit_id) where status in ('queued','running');

-- Default deny: the server validates the independent admin session before using these tables.
do $$ declare t text; begin
 foreach t in array array['platform_admins','platform_admin_sessions','admin_audit_log','curriculum_units','curriculum_content_versions','curriculum_generation_jobs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

create function public.admin_auth_attempt(p_username text,p_token text,p_observed text,p_matches boolean,p_mode text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare a public.platform_admins; s public.platform_admin_sessions; begin
 if p_mode is null or p_mode not in ('password','pin','reauth') then return jsonb_build_object('status',400); end if;
 if p_mode='password' then
  select * into a from public.platform_admins where username=p_username for update;
 else
  select * into s from public.platform_admin_sessions where token_hash=p_token and expires_at>now();
  select * into a from public.platform_admins where id=s.admin_id for update;
  if s.credential_version is distinct from a.credential_version then return jsonb_build_object('status',401); end if;
 end if;
 if a.id is null or not a.enabled then return jsonb_build_object('status',401); end if;
 if a.locked_until>now() then return jsonb_build_object('status',429); end if;
 if p_observed is distinct from (case when p_mode in ('password','reauth') then a.password_hash else a.pin_hash end) then return jsonb_build_object('status',401); end if;
 if not p_matches then
  if p_mode='password' then
   update public.platform_admins set password_failures=password_failures+1,locked_until=case when password_failures+1>=5 then now()+interval '5 minutes' else null end where id=a.id;
  else
   update public.platform_admins set pin_failures=pin_failures+1,locked_until=case when pin_failures+1>=5 then now()+interval '5 minutes' else null end where id=a.id;
  end if;
  return jsonb_build_object('status',401);
 end if;
 update public.platform_admins set password_failures=0,pin_failures=0,locked_until=null where id=a.id;
 if p_mode='password' then
  delete from public.platform_admin_sessions where expires_at<now();
  insert into public.platform_admin_sessions(token_hash,admin_id,credential_version) values(p_token,a.id,a.credential_version);
 elsif p_mode='pin' then
  update public.platform_admin_sessions set unlocked_until=now()+interval '15 minutes' where token_hash=p_token;
 elsif p_mode='reauth' then
  update public.platform_admin_sessions set password_verified_at=now() where token_hash=p_token;
 end if;
 return jsonb_build_object('status',200,'admin_id',a.id,'username',a.username);
end $$;

create function public.admin_publish_content(p_id uuid,p_admin uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare v public.curriculum_content_versions; begin
 select * into v from public.curriculum_content_versions where id=p_id;
 if v.id is null then raise exception 'Content not found'; end if;
 perform 1 from public.curriculum_units where id=v.unit_id for update;
 select * into v from public.curriculum_content_versions where id=p_id for update;
 if exists(select 1 from public.curriculum_units where id=v.unit_id and archived) then raise exception 'Archived units cannot be published'; end if;
 if v.status<>'validated' then raise exception 'Validate and review this draft before publishing'; end if;
 update public.curriculum_content_versions set status='archived' where unit_id=v.unit_id and status='published';
 update public.curriculum_content_versions set status='published',published_at=now() where id=p_id;
 insert into public.admin_audit_log(admin_id,action,target_id) values(p_admin,'content.publish',p_id::text);
end $$;

create function public.admin_claim_generation(p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.curriculum_generation_jobs; l uuid=gen_random_uuid(); begin
 -- Expired leases are reclaimed with bounded retries; nothing depends on a browser tab.
 update public.curriculum_generation_jobs set status='failed',error='Worker retry limit reached',finished_at=now() where status='running' and lease_until<now() and attempts>=3;
 select * into j from public.curriculum_generation_jobs
 where (p_id is null or id=p_id) and (status='queued' or (status='running' and lease_until<now())) and attempts<3
 order by created_at for update skip locked limit 1;
 if j.id is null then return null; end if;
 update public.curriculum_generation_jobs set status='running',lease_id=l,lease_until=now()+interval '2 minutes',attempts=attempts+1,error=null where id=j.id;
 return to_jsonb(j)||jsonb_build_object('lease_id',l);
end $$;

create function public.admin_finish_generation(p_job uuid,p_lease uuid,p_content jsonb,p_error text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j public.curriculum_generation_jobs; v uuid=gen_random_uuid(); n integer; begin
 select * into j from public.curriculum_generation_jobs where id=p_job for update;
 if j.id is null or j.status<>'running' or j.lease_id is distinct from p_lease then return jsonb_build_object('status',coalesce(j.status,'missing')); end if;
 if p_error is not null then
  update public.curriculum_generation_jobs set status='failed',error=p_error,finished_at=now(),lease_until=null where id=p_job;
  return jsonb_build_object('status','failed');
 end if;
 perform 1 from public.curriculum_units where id=j.unit_id for update;
 select coalesce(max(version),0)+1 into n from public.curriculum_content_versions where unit_id=j.unit_id;
 insert into public.curriculum_content_versions(id,unit_id,version,content,created_by) values(v,j.unit_id,n,p_content,j.created_by);
 update public.curriculum_generation_jobs set status='completed',result_version_id=v,finished_at=now(),lease_until=null where id=p_job;
 insert into public.admin_audit_log(admin_id,action,target_id,details) values(j.created_by,'generation.completed',p_job::text,jsonb_build_object('version_id',v));
 return jsonb_build_object('status','completed','version_id',v);
end $$;

create function public.admin_change_account(p_actor uuid,p_target uuid,p_password text,p_pin text,p_enabled boolean)
returns void language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(91824711);
 if p_actor=p_target and p_enabled=false then raise exception 'You cannot disable your own account'; end if;
 if p_enabled=false and (select count(*) from public.platform_admins where enabled)<=1 then raise exception 'Keep at least one active administrator'; end if;
 update public.platform_admins set password_hash=coalesce(p_password,password_hash),pin_hash=coalesce(p_pin,pin_hash),enabled=coalesce(p_enabled,enabled),
 credential_version=gen_random_uuid() where id=p_target;
 if not found then raise exception 'Administrator not found'; end if;
 delete from public.platform_admin_sessions where admin_id=p_target;
 insert into public.admin_audit_log(admin_id,action,target_id) values(p_actor,'admin.account_changed',p_target::text);
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admin_auth_attempt','admin_publish_content','admin_claim_generation','admin_finish_generation','admin_change_account') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- Direct owner edits to the account table must invalidate remembered sessions too.
create function public.admin_rotate_credentials() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.password_hash is distinct from old.password_hash or new.pin_hash is distinct from old.pin_hash or new.enabled is distinct from old.enabled then
  new.credential_version=gen_random_uuid();
 end if;
 return new;
end $$;
create trigger admin_account_credentials before update on public.platform_admins for each row execute function public.admin_rotate_credentials();
revoke all on function public.admin_rotate_credentials() from public,anon,authenticated;

create function public.admin_create_draft(p_unit uuid,p_admin uuid,p_content jsonb) returns uuid
language plpgsql security invoker set search_path='' as $$
declare v uuid=gen_random_uuid(); n integer; begin
 perform 1 from public.curriculum_units where id=p_unit and not archived for update;
 if not found then raise exception 'Select an active curriculum unit'; end if;
 select coalesce(max(version),0)+1 into n from public.curriculum_content_versions where unit_id=p_unit;
 insert into public.curriculum_content_versions(id,unit_id,version,content,created_by) values(v,p_unit,n,p_content,p_admin);
 insert into public.admin_audit_log(admin_id,action,target_id) values(p_admin,'content.import',v::text);
 return v;
end $$;
revoke all on function public.admin_create_draft(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admin_create_draft(uuid,uuid,jsonb) to service_role;
