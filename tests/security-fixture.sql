create table public.families(id text primary key,name text,primary_holder_name text,primary_holder_email text,primary_holder_phone text,password_hash text,updated_at timestamptz);
create table public.members(id text primary key,family_id text,name text,role text,color text,pin_hash text,email text,phone text,year_level text,can_add_tasks boolean,can_add_shopping boolean);
create table public.events(id text primary key,family_id text,member_id text,title text,recurrence text,day integer,days jsonb,date date,skip_dates jsonb,occurrence_overrides jsonb,start_min integer,end_min integer,location text,notes text,needs_drive boolean,driver_id text,travel_min integer,color text,recurrence_end_date date);
create table public.chores(id text primary key,family_id text,member_id text,title text,frequency text,days jsonb,day_of_month integer,start_date date,due_date date,due_time text,points integer,active boolean,pending_approval boolean,icon text);
create table public.chore_library_items(family_id text,title text);
create table public.quick_list_items(id text primary key,family_id text,name text,added_by text);
create table public.shopping_item_library_items(family_id text,name text);
create table public.shopping_lists(id text primary key,family_id text,date date,data jsonb,updated_at timestamptz);
alter table families add column login_password_hash text, add column login_password_version text;
create table family_device_sessions(token_hash text primary key,family_id text,password_version text);
create function public.get_family_data(text) returns jsonb language sql as $$select '{}'::jsonb$$;
create function public.family_id() returns text language sql as $$select null::text$$;

create function public.save_family_data(text,jsonb) returns void language sql as $$select$$;
