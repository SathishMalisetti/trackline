const {test}=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='server-test-key';
let replies=[],calls=[];
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{calls.push(args);const r=replies.shift();if(!r)throw Error('Unexpected request');return{ok:r.status<400,status:r.status,headers:{get:k=>r.headers?.[k]||null},json:async()=>r.body,text:async()=>r.text};}};
const I=require('../shared/admin-import'),A=require('../shared/admin'),manage=require('../admin-manage'),worker=require('../admin-worker');
const id='11111111-1111-4111-8111-111111111111',token='a'.repeat(64);
// Fictional curriculum records for structural tests, not real VCAA descriptors.
function fixture(subject='Mathematics',years=[4,7]){
 const prefix=subject==='Mathematics'?'VC2M':subject==='English'?'VC2E':'VC2S';
 const levels=years.map(year=>({id:subject==='Science'?(year===4?'3–4':'7–8'):String(year),level:subject==='Science'?(year===4?'Levels 3 and 4':'Levels 7 and 8'):'Level '+year,achievementStandardContent:'<p>Fictional achievement standard.</p>',levelDescriptionContent:'<p>Fictional level description.</p>',contentDescriptionsContent:[{title:'Example strand',contentDescriptions:subject==='English'?[]:[descriptor(year)],...(subject==='English'?{subStrands:[{title:'Example substrand',contentDescriptions:[descriptor(year)]}]}:{})}]}));
 function descriptor(year){return{id:'example-'+year,internalId:year,code:prefix+(subject==='Science'&&year===7?8:year)+'N99',stem:'Students learn to:',contentDescription:'<p>Investigate fictional examples for a parser regression test.</p>',elaborations:[{id:'example',elaborationText:'<p>Fictional examples &amp; context.</p>'}],achievementExtracts:[]};}
 const data={buildId:'fixture-build',props:{pageProps:{additionalContent:{curriculum:{disciplineCapabilityLanguageTitle:subject,pathways:[{pathway_id:'Standard',curriculum:levels}]}}}}};
 return{data,html:()=>'<html>Victorian Curriculum F–10 Version 2.0<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify(data)+'</script></html>'};
}
function auth(){return[{status:200,body:[{token_hash:A.digest(token),admin_id:id,credential_version:'v1',expires_at:new Date(Date.now()+86400000).toISOString(),unlocked_until:new Date(Date.now()+900000).toISOString(),password_verified_at:new Date().toISOString()}]},{status:200,body:[{id,username:'owner',enabled:true,credential_version:'v1'}]}];}
async function run(handler,body,rows){calls=[];replies=rows;const c={};await handler(c,{method:'POST',headers:{cookie:'__Host-trackline-admin='+token},body,query:{}});return c.res;}
test('extracts explicit years and science bands, preserving official source guidance',()=>{
 for(const subject of Object.keys(I.sources)){const f=fixture(subject);const r=I.extract(f.html(),subject,[4,7]);assert.equal(r.units.length,2);assert.deepEqual(r.units.map(u=>u.year_level),[4,7]);assert.ok(r.units.every(u=>u.source_details.attribution.includes('VCAA')));assert.equal(r.units[0].source_details.elaborations[0].text,'Fictional examples & context.');}
 const r=I.extract(fixture('Science').html(),'Science',[7]);assert.equal(r.units[0].descriptor_code,'VC2S8N99');assert.deepEqual(r.units[0].source_details.level_ids,[7,8]);
 assert.equal(I.plain('5<sup>2</sup> + H<sub>2</sub>O + &frac12;'),'5^(2) + H_(2)O + ½');
});
test('source changes fail closed rather than guessing missing subjects, levels or codes',()=>{
 const f=fixture();assert.throws(()=>I.extract(f.html(),'English',[4]),/subject/);
 assert.throws(()=>I.extract(f.html(),'Mathematics',[6]),/missing/);
 const level=f.data.props.pageProps.additionalContent.curriculum.pathways[0].curriculum[0];level.contentDescriptionsContent[0].contentDescriptions[0].code='made-up';assert.throws(()=>I.extract(f.html(),'Mathematics',[4]),/descriptor structure/);
 assert.throws(()=>I.extract('<html>changed page</html>','Mathematics',[4]),/unrecognised/);
});
test('duplicate codes are rejected and unchanged records have stable canonical hashes',()=>{
 const f=fixture();const a=I.extract(f.html(),'Mathematics',[4]);const b=I.extract(f.html().replace('fixture-build','another-build'),'Mathematics',[4]);assert.equal(a.units[0].source_record_hash,b.units[0].source_record_hash);
 const ds=f.data.props.pageProps.additionalContent.curriculum.pathways[0].curriculum[0].contentDescriptionsContent[0].contentDescriptions;ds.push(ds[0]);assert.throws(()=>I.extract(f.html(),'Mathematics',[4]),/duplicate/);
});
test('download uses only the fixed official source and stores a lossless compressed snapshot',async()=>{
 const html=fixture().html();calls=[];replies=[{status:200,text:html,headers:{'content-type':'text/html','etag':'fixture-etag'}}];
 const r=await I.download('Mathematics',[4]);assert.equal(calls[0][0],I.sources.Mathematics);assert.equal(calls[0][1].redirect,'error');assert.equal(r.provenance.source_etag,'fixture-etag');assert.equal(zlib.gunzipSync(Buffer.from(r.provenance.source_archive_base64,'base64')).toString(),html);assert.match(r.provenance.source_sha256,/^[a-f0-9]{64}$/);
});
test('import queues validate selections and require an independent unlocked admin',async()=>{
 let r=await run(manage,{action:'source-import-queue',subjects:['Unknown'],years:[4]},auth());assert.equal(r.status,400);assert.equal(calls.length,2);
 r=await run(manage,{action:'source-import-queue',subjects:['Mathematics'],years:[4,7]},[...auth(),{status:200,body:{queued:1,already_active:0}}]);assert.equal(r.status,200);assert.deepEqual(JSON.parse(calls[2][1].body).p_years,[4,7]);
 const c={};calls=[];replies=[];await manage(c,{method:'POST',headers:{},body:{action:'source-import-queue',subjects:['Mathematics'],years:[4]},query:{}});assert.equal(c.res.status,401);assert.equal(calls.length,0);
});
test('worker can import official references without an AI key and finishes through its lease',async()=>{
 delete process.env.OPENAI_API_KEY;process.env.ADMIN_GENERATION_WORKER_KEY='b'.repeat(32);
 const job={id,lease_id:id,subject:'Mathematics',year_levels:[4],source_url:I.sources.Mathematics};
 calls=[];replies=[{status:200,body:job},{status:200,text:fixture().html(),headers:{'content-type':'text/html'}},{status:200,body:{status:'completed',created:1}}];const c={};await worker(c,{method:'POST',headers:{'x-admin-worker-key':process.env.ADMIN_GENERATION_WORKER_KEY}});assert.equal(c.res.status,200);assert.equal(JSON.parse(c.res.body).status,'completed');assert.equal(JSON.parse(calls[2][1].body).p_lease,id);assert.equal(calls.length,3);delete process.env.ADMIN_GENERATION_WORKER_KEY;
});
test('mismatched job URLs cannot fetch arbitrary hosts',async()=>{
 calls=[];replies=[{status:200,body:{id,lease_id:id,subject:'Mathematics',year_levels:[4],source_url:'http://127.0.0.1/secret'}},{status:200,body:{status:'failed'}}];const r=await I.processImport();assert.equal(r.status,'failed');assert.equal(calls.length,2);assert.ok(calls.every(c=>c[0].startsWith(process.env.SUPABASE_URL)));
});
test('imported references cannot be manually altered and generated snapshots retain provenance',async()=>{
 const r=await run(manage,{action:'unit-save',id,title:'Changed',subject:'Mathematics',year_level:4,source_url:I.sources.Mathematics,descriptor_code:'VC2M4N99',descriptor_text:'Fictional new descriptor'},[...auth(),{status:200,body:[{source_import_id:id}]}]);assert.equal(r.status,409);assert.equal(calls.length,3);
 const ref=I.reference({source_import_id:id,source_record_hash:'a'.repeat(64),source_details:{level_label:'Level 4'}});assert.equal(ref.source_import_id,id);assert.equal(ref.source_level,'Level 4');assert.ok(ref.attribution.includes('CC-BY-NC'));
});
