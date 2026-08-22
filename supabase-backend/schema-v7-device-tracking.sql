-- Trackline — Device pairing + usage tracking (v9)
-- Supersedes the earlier, simpler `device_usage` table from the previous
-- round — this replaces it with the richer, hour-bucketed schema from the
-- ActivityWatch design doc, plus a `devices` table for scoped pairing
-- tokens (Option A: laptop never talks to Supabase directly, everything
-- goes through our backend, which holds the service_role key server-side
-- only — same pattern as every other write in this app).

drop table if exists device_usage; -- superseded by `usage` below

create table if not exists devices (
  id text primary key,                      -- device_id, generated at pairing
  family_id text not null references families(id) on delete cascade,
  member_id text not null,                  -- which family member this device is paired to
  hostname text,
  label text,                               -- optional friendly name, e.g. "Mia's Laptop"
  device_token_hash text not null,          -- hashed like the family password — never store the raw token
  paired_at timestamptz not null default now(),
  last_sync_at timestamptz,
  revoked boolean not null default false
);
create index if not exists idx_devices_family on devices(family_id);

create table if not exists usage (
  id bigint generated always as identity primary key,
  device_id text not null references devices(id) on delete cascade,
  family_id text not null references families(id) on delete cascade,
  member_id text not null,
  hostname text not null,
  date date not null,
  hour smallint not null,
  source text not null,        -- 'app' or 'site'
  name text not null,          -- e.g. 'roblox.exe' or 'youtube.com'
  title text not null default '',  -- window title, e.g. 'Roblox' or an IXL practice page title — '' (not NULL) for sites, since Postgres treats every NULL as distinct in a unique constraint and would silently break upserting
  category text,               -- e.g. 'Study', 'Games', 'Uncategorized' — assigned from app/domain name only, never derived from title
  active_seconds numeric not null,
  updated_at timestamptz not null default now(),
  unique (device_id, date, hour, source, name, title)
);
create index if not exists idx_usage_family_member_date on usage(family_id, member_id, date);
create index if not exists idx_usage_device on usage(device_id);

alter table devices enable row level security;
alter table usage enable row level security;
-- No policies — only the backend (service_role) ever touches these tables
-- directly. The laptop agent never gets service_role; it authenticates to
-- OUR backend with its own scoped device token instead (verified against
-- devices.device_token_hash), and the backend does the actual Supabase
-- write. This is the whole point of Option A.

-- Migration for anyone who already ran this schema before the category
-- column existed (CREATE TABLE IF NOT EXISTS above is a no-op once the
-- table already exists, so this is needed to actually apply it):
alter table usage add column if not exists category text;

-- Migration for the title column + widened uniqueness key (same app can
-- have many distinct titles within one hour, e.g. many different Chrome
-- tabs) — safe to run even on a table with existing rows, since every
-- existing row currently has an implicit NULL title and was already
-- unique under the old (device_id,date,hour,source,name) key, so adding
-- title to the key doesn't create any conflicts.
alter table usage add column if not exists title text not null default '';
alter table usage drop constraint if exists usage_device_id_date_hour_source_name_key;
alter table usage add constraint usage_device_id_date_hour_source_name_title_key
  unique (device_id, date, hour, source, name, title);
