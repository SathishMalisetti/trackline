const {PGlite}=require('@electric-sql/pglite'),fs=require('fs'),assert=require('node:assert/strict');
(async()=>{const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');await db.exec(fs.readFileSync('admin/schema.sql','utf8'));await db.exec(fs.readFileSync('admin/curriculum-import.sql','utf8'));
 const actor='11111111-1111-4111-8111-111111111111';await db.query("insert into platform_admins(id,username,password_hash,pin_hash) values($1,'owner','scrypt:fake','scrypt:fake')",[actor]);
 await db.exec('set role service_role');
 const queue=()=>db.query('select admin_queue_curriculum_import($1,$2,$3) r',[actor,['Mathematics'],[4,7]]);
 assert.equal((await queue()).rows[0].r.queued,1);assert.equal((await queue()).rows[0].r.already_active,1);
 await assert.rejects(db.query('select admin_queue_curriculum_import($1,$2,$3)',[actor,['Unknown'],[4]]),/supported/);
 const claim=async()=>((await db.query('select admin_claim_curriculum_import(null) r')).rows[0].r),first=await claim();assert.equal(await claim(),null);
 const unit=(hash,text='Fictional curriculum descriptor')=>({year_level:4,title:'Test reference',descriptor_code:'VC2M4N99',descriptor_text:text,source_record_hash:hash,source_details:{level_label:'Level 4',attribution:'Fixture'}});
 const provenance={source_url:first.source_url,source_sha256:'f'.repeat(64),source_fetched_at:new Date().toISOString(),source_bytes:100,source_archive_base64:'fixture',parser_version:'fixture',attribution:'Fixture',licence_url:'https://f10.vcaa.vic.edu.au/copyright-statement'};
 const finish=(j,units,error=null)=>db.query('select admin_finish_curriculum_import($1,$2,$3,$4,$5) r',[j.id,j.lease_id,provenance,units,error]);
 assert.equal((await finish(first,[unit('a'.repeat(64))])).rows[0].r.created,1);
 const saved=(await db.query('select * from curriculum_units')).rows[0];await db.query("insert into curriculum_content_versions(unit_id,version,status,content) values($1,1,'published',$2)",[saved.id,{lesson:'Existing lesson remains unchanged'}]);
 await queue();const second=await claim();assert.equal((await finish(second,[unit('a'.repeat(64))])).rows[0].r.unchanged,1);assert.equal((await db.query('select count(*)::int n from curriculum_units')).rows[0].n,1);
 await queue();const third=await claim();assert.equal((await finish(third,[unit('b'.repeat(64),'Revised fictional descriptor')])).rows[0].r.revised,1);assert.equal((await db.query('select supersedes_unit_id from curriculum_units where source_record_hash=$1',['b'.repeat(64)])).rows[0].supersedes_unit_id,saved.id);
 assert.equal((await db.query('select content from curriculum_content_versions')).rows[0].content.lesson,'Existing lesson remains unchanged');
 assert.equal((await db.query('select source_current from curriculum_units where id=$1',[saved.id])).rows[0].source_current,false);
 await queue();const fourth=await claim();await assert.rejects(finish(fourth,[unit('c'.repeat(64)),{...unit('d'.repeat(64)),year_level:6}]),/Invalid curriculum reference/);assert.equal((await db.query('select count(*)::int n from curriculum_units')).rows[0].n,2);
 await db.query("update curriculum_source_imports set status='cancelled' where id=$1",[fourth.id]);assert.equal((await finish(fourth,[unit('c'.repeat(64))])).rows[0].r.status,'cancelled');
 await queue();const fifth=await claim();await db.query("update curriculum_source_imports set lease_until=now()-interval '1 minute' where id=$1",[fifth.id]);const reclaimed=await claim();assert.notEqual(reclaimed.lease_id,fifth.lease_id);await finish(fifth,[unit('c'.repeat(64))]);assert.equal((await db.query('select count(*)::int n from curriculum_units')).rows[0].n,2);await finish(reclaimed,null,'Fixture failure');
 assert.equal((await db.query('select count(*)::int n from curriculum_import_items')).rows[0].n,3);
 await db.exec('reset role');
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);for(const table of ['curriculum_source_imports','curriculum_import_items'])await assert.rejects(db.query('select * from '+table),/permission denied/);await assert.rejects(queue(),/permission denied/);await db.exec('reset role');}
 console.log('PASS: import queue isolation, leases, idempotent references, source revisions, existing lesson preservation, rollback, cancellation and public denial.');
 }finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1});
