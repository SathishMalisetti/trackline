// Execute the migration in an isolated PostgreSQL engine with a minimal fixture.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; grant usage on schema auth to authenticated;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table public.families(id text primary key);
      create table public.members(id text primary key, family_id text references families(id), role text);
      create table public.chores(id text primary key);
      create function public.get_family_data(text) returns jsonb language sql security definer as $$ select '{}'::jsonb $$;
      create function public.save_family_data(text,jsonb) returns void language sql security definer as $$ select $$;
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
      insert into families values ('FAMILY1'),('FAMILY2');
      insert into members values ('p1','FAMILY1','parent'),('p2','FAMILY2','parent');
    `);
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261005222249_add_trackline_auth.sql'), 'utf8'));
    await db.exec(`
      insert into family_auth_memberships values
        ('00000000-0000-0000-0000-000000000001','FAMILY1','p1','parent'),
        ('00000000-0000-0000-0000-000000000002','FAMILY2','p2','parent');
      set role authenticated;
      set request.jwt.claim.sub='00000000-0000-0000-0000-000000000001';
    `);
    assert.deepEqual((await db.query('select family_id from family_auth_memberships')).rows, [{ family_id: 'FAMILY1' }]);
    for (const sql of ['select * from families', "select get_family_data('FAMILY1')", 'delete from family_auth_memberships']) {
      await assert.rejects(db.query(sql), /permission denied/);
    }
    await db.exec('reset role; set role anon;');
    await assert.rejects(db.query('select * from family_auth_memberships'), /permission denied/);
    await db.exec('reset role; set role service_role;');
    assert.equal((await db.query('select * from family_auth_memberships')).rows.length, 2);
    console.log('SQL checks passed: account RLS, denied direct table/RPC access, no client membership writes, service-role access.');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
