const {PGlite} = require('@electric-sql/pglite');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
(async()=>{
  const db = new PGlite();
  try {
    await db.exec('create role anon; create role authenticated; create role service_role;');
    await db.exec(fs.readFileSync(path.join(__dirname,'security-fixture.sql'),'utf8'));
    for (const file of ['family-isolation.sql','shopping-isolation.sql','family-credentials.sql'])
      await db.exec(fs.readFileSync(path.join(__dirname,'../security',file),'utf8'));
    const save = (data)=>db.query('select public.save_family_data($1,$2)', ['familyA',data]);
    const baseline={family:{id:'familyA',name:'A'},members:[{id:'parentA',name:'Parent',role:'parent',color:'#ffffff'}],events:[],chores:[],shoppingList:[]};
    await save(baseline);
    await db.exec("insert into families(id,name) values ('familyB','B'); insert into members(id,family_id,name) values ('parentB','familyB','Other parent'); insert into events(id,family_id,title) values ('eventB','familyB','School'); insert into chores(id,family_id,title) values ('choreB','familyB','Swimming'); insert into quick_list_items(id,family_id,name) values ('itemB','familyB','Bread');");
    await db.exec("update families set password_hash='private-password' where id='familyA'; update members set pin_hash='private-pin' where id='parentA';");
    baseline.family.passwordHash='client-forgery';baseline.members[0].pinHash='client-forgery';await save(baseline);
    assert.equal((await db.query("select password_hash from families where id='familyA'")).rows[0].password_hash,'private-password');
    assert.equal((await db.query("select pin_hash from members where id='parentA'")).rows[0].pin_hash,'private-pin');
    await db.exec("insert into family_device_sessions values ('current','familyA','private-password'),('other','familyA','private-password'),('unrelated','familyB','b');");
    await db.query('select public.set_family_password_secure($1,$2,$3,$4)',['familyA','salted','random-version','current']);
    assert.equal((await db.query("select password_version from family_device_sessions where token_hash='current'")).rows[0].password_version,'random-version');
    assert.equal((await db.query("select count(*)::int n from family_device_sessions")).rows[0].n,2);
    const before=(await db.query('select name from families where id=\'familyA\'')).rows;
    for (const [key,id] of [['members','parentB'],['events','eventB'],['chores','choreB'],['shoppingList','itemB']]) {
      const attack=structuredClone(baseline); attack.family.name='must roll back';
      attack[key].push({id,name:'changed',title:'changed',role:'parent'});
      await assert.rejects(save(attack), /Record does not belong/);
      assert.deepEqual((await db.query("select name from families where id='familyA'")).rows,before);
    }
    assert.equal((await db.query("select name from members where id='parentB'")).rows[0].name,'Other parent');
    baseline.events.push({id:'eventA',memberId:'parentA',title:'Office',start:540,end:1020});
    baseline.chores.push({id:'choreA',memberId:'parentA',title:'Task'});
    await save(baseline); baseline.events[0].title='Updated'; await save(baseline);
    assert.equal((await db.query("select title from events where id='eventA'")).rows[0].title,'Updated');
    const trip=(family,id)=>db.query('select public.save_shopping_trip($1,$2)',[family,{id,date:'2026-10-14',items:[]}]);
    await trip('familyB','tripB');
    await assert.rejects(trip('familyA','tripB'),/Record does not belong/);
    assert.equal((await db.query("select family_id from shopping_lists where id='tripB'")).rows[0].family_id,'familyB');
    await trip('familyA','tripA'); await trip('familyA','tripA');
    for (const role of ['anon','authenticated']) {
      await db.exec('set role '+role);
      await assert.rejects(save(baseline),/permission denied/);
      await assert.rejects(trip('familyA','tripA'),/permission denied/);
      await db.exec('reset role');
    }
    console.log('PASS: own-family save/update; four cross-family rollback cases; trip isolation; anonymous RPC denial.');
  } finally { await db.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
