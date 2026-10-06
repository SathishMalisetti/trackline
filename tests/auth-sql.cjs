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
      create table public.families(id text primary key, name text, primary_holder_name text, primary_holder_email text);
      create table public.members(id text primary key, family_id text references families(id), role text, name text, color text, email text, pin_hash text);
      create table public.chores(id text primary key);
      create function public.get_family_data(text) returns jsonb language sql security definer as $$ select '{}'::jsonb $$;
      create function public.save_family_data(text,jsonb) returns void language sql security definer as $$ select $$;
      insert into auth.users values ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
      insert into families(id) values ('FAMILY1'),('FAMILY2');
      insert into members(id,family_id,role) values ('p1','FAMILY1','parent'),('p2','FAMILY2','parent');
    `);
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261005222249_add_trackline_auth.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261006005119_self_service_family_onboarding.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261006011119_profile_pin_attempts.sql'), 'utf8'));
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
    await assert.rejects(db.query("select create_family_for_account('00000000-0000-0000-0000-000000000001','a@example.com','Family','Parent')"), /permission denied/);
    await db.exec('reset role; set role authenticated;');
    await assert.rejects(db.query("select check_profile_pin_attempt('p1','FAMILY1',null,true,'hash')"), /permission denied/);
    await assert.rejects(db.query("select create_family_for_account('00000000-0000-0000-0000-000000000001','a@example.com','Family','Parent')"), /permission denied/);
    await db.exec("reset role; insert into auth.users values ('00000000-0000-0000-0000-000000000003'); set role service_role;");
    const create = "select create_family_for_account('00000000-0000-0000-0000-000000000003','new@example.com','New Family','New Parent') as result";
    const first = (await db.query(create)).rows[0].result;
    assert.equal(first.role, 'parent');
    assert.deepEqual((await db.query(create)).rows[0].result, first);
    assert.equal((await db.query('select count(*)::int as count from families')).rows[0].count, 3);
    assert.equal((await db.query('select count(*)::int as count from members')).rows[0].count, 3);
    await assert.rejects(db.query("select create_family_for_account('00000000-0000-0000-0000-000000000004','missing@example.com','Missing Family','Parent')"), /foreign key/);
    assert.equal((await db.query('select count(*)::int as count from families')).rows[0].count, 3);
    await db.exec('reset role; set role service_role;');
    assert.equal((await db.query('select * from family_auth_memberships')).rows.length, 3);
    const attempt = (observed, matches, replacement) => db.query('select check_profile_pin_attempt($1,$2,$3,$4,$5) as result', ['p1','FAMILY1',observed,matches,replacement]);
    assert.equal((await attempt(null,true,'stored-hash')).rows[0].result.status, 200);
    assert.equal((await attempt(null,true,'overwrite')).rows[0].result.status, 409);
    for (let i=0;i<5;i++) assert.equal((await attempt('stored-hash',false,null)).rows[0].result.status, 403);
    assert.equal((await attempt('stored-hash',true,null)).rows[0].result.status, 429);
    await db.exec("update members set pin_locked_until=now()-interval '1 second' where id='p1'");
    assert.equal((await attempt('stored-hash',true,null)).rows[0].result.status, 200);
    assert.equal((await db.query("select pin_failed_attempts from members where id='p1'")).rows[0].pin_failed_attempts, 0);
    console.log('SQL checks passed: account RLS, denied direct table/RPC access, no client membership writes, service-role access.');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
