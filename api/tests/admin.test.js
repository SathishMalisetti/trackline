const {test}=require('node:test'),assert=require('node:assert/strict');
process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-server-key';
let replies=[],calls=[];
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{calls.push(args);const r=replies.shift();if(!r)throw Error('Unexpected request');return{ok:r.status<400,status:r.status,json:async()=>r.body};}};
const A=require('../shared/admin'),G=require('../shared/admin-generation');
const session=require('../admin-session'),manage=require('../admin-manage'),worker=require('../admin-worker');
const account={id:'11111111-1111-4111-8111-111111111111',username:'owner',enabled:true,credential_version:'v1'};
const t='a'.repeat(64);
function authRows(extra={}){return[{status:200,body:[{token_hash:A.digest(t),admin_id:account.id,credential_version:'v1',expires_at:new Date(Date.now()+86400000).toISOString(),unlocked_until:new Date(Date.now()+900000).toISOString(),password_verified_at:new Date().toISOString(),...extra}]},{status:200,body:[account]}];}
const request=(body={},method='POST')=>({method,headers:{cookie:'__Host-trackline-admin='+t},query:{},body});
async function run(handler,req,rows=[]){replies=rows;calls=[];const c={};await handler(c,req);return c.res;}
const skill={title:'Addition',prerequisites:['Place value'],lesson:'A sufficiently detailed lesson explaining addition with carrying.',worked_examples:['27 + 18 = 45'],writing_rubric:[],questions:Array.from({length:4},(_,i)=>({question:'Question '+i,type:'mcq',options:['45','35'],answer:'45',explanation:'Add the ones and carry into the tens.',purpose:'practice',difficulty:'introductory'}))};
test('family cookies and claimed parent/admin roles cannot access platform administration',async()=>{
 const r=await run(manage,{method:'GET',headers:{cookie:'__Host-trackline-family='+t,authorization:'Bearer claimed-admin'},query:{kind:'admins'}});
 assert.equal(r.status,401);assert.equal(calls.length,0);
});
test('signed-out admin status reveals no database data',async()=>{
 const r=await run(session,{method:'GET',headers:{},query:{}});assert.deepEqual(JSON.parse(r.body),{signedIn:false,unlocked:false,admin:null});assert.equal(calls.length,0);
});
test('password login issues a separate secure cookie and requires PIN afterwards',async()=>{
 const hash=await A.hashSecret('long-password-here');
 const r=await run(session,{method:'POST',headers:{},body:{action:'login',username:'owner',password:'long-password-here'}},[{status:200,body:[{...account,password_hash:hash}]},{status:200,body:{status:200}},{status:200,body:[]}]);
 assert.equal(r.status,200);assert.match(r.headers['Set-Cookie'],/__Host-trackline-admin=.*HttpOnly; Secure; SameSite=Strict/);assert.ok(!r.body.includes('scrypt:'));
 assert.equal(JSON.parse(calls[1][1].body).p_mode,'password');
});
test('unverified PIN and rotated credentials fail closed',async()=>{
 let r=await run(manage,request({},'GET'),authRows({unlocked_until:null}));assert.equal(r.status,423);assert.equal(calls.length,2);
 r=await run(manage,request({},'GET'),authRows({credential_version:'old'}));assert.equal(r.status,401);
});
test('PIN verification uses the independent admin account and atomic limiter',async()=>{
 const pin=await A.hashSecret('1234');const r=await run(session,request({action:'pin',pin:'1234'}),[...authRows(),{status:200,body:[{...account,password_hash:'hidden',pin_hash:pin}]},{status:200,body:{status:200}},{status:200,body:[]}]);
 assert.equal(r.status,200);assert.equal(JSON.parse(calls[3][1].body).p_matches,true);assert.ok(!r.body.includes(pin));
});
test('publishing requires recent password and explicit educational review',async()=>{
 const b={action:'version-publish',id:'22222222-2222-4222-8222-222222222222',reviewConfirmed:true};
 let r=await run(manage,request(b),authRows({password_verified_at:new Date(Date.now()-600000).toISOString()}));assert.equal(r.status,428);assert.equal(calls.length,2);
 r=await run(manage,request(b),authRows({password_verified_at:null}));assert.equal(r.status,428);
 r=await run(manage,request({...b,reviewConfirmed:false}),authRows());assert.equal(r.status,400);
});
test('family detail access is audited first; audit failure prevents data retrieval',async()=>{
 const r=await run(manage,request({action:'family-open',familyId:'FAMILY1'}),[...authRows(),{status:500,body:{}}]);assert.equal(r.status,503);assert.equal(calls.length,3);assert.ok(calls[2][0].includes('admin_audit_log'));
 assert.deepEqual(manage.scrub({passwordHash:'secret',pin_hash:'secret',device_token:'secret',member:{name:'Kid',password_hash:'secret'}}),{member:{name:'Kid'}});
});
test('account creation never returns password or PIN hashes',async()=>{
 const r=await run(manage,request({action:'admin-create',username:'another',password:'long-password-here',pin:'2345'}),[...authRows(),{status:200,body:[{...account,username:'another',password_hash:'scrypt:private',pin_hash:'scrypt:private'}]},{status:200,body:[]}]);assert.equal(r.status,200);assert.ok(!/password|pin_hash|scrypt/.test(r.body));
});
test('worker requires its own server secret, never a family/admin browser cookie',async()=>{
 process.env.ADMIN_GENERATION_WORKER_KEY='b'.repeat(32);
 const r=await run(worker,request());assert.equal(r.status,401);assert.equal(calls.length,0);delete process.env.ADMIN_GENERATION_WORKER_KEY;
});
test('draft validation rejects invalid answers and malformed writing rubrics',()=>{
 assert.deepEqual(G.validate({skills:[skill]}),[]);
 const c=structuredClone(skill);c.questions[0].answer='not an option';assert.ok(G.validate({skills:[c]}).length);
 c.questions[0].answer='45';c.writing_rubric=[{criterion:'Grammar',description:'Correct usage',weight:80}];assert.ok(G.validate({skills:[c]}).length);
 assert.ok(G.validate({skills:[null]}).length);c.questions=[null,null,null,null];c.writing_rubric=[null];assert.ok(G.validate({skills:[c]}).length);
});
test('generation uses server-only credentials, structured output and no curriculum fetching',async()=>{
 process.env.OPENAI_API_KEY='test-only-key';replies=[{status:200,body:{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({skills:[skill]})}]}]}}];calls=[];
 const result=await G.generate({title:'Addition',year_level:4,subject:'Mathematics',descriptor_code:'CODE',descriptor_text:'Provided reference only',source_url:'https://f10.vcaa.vic.edu.au/'});
 assert.equal(result.skills.length,1);assert.equal(calls.length,1);assert.equal(calls[0][0],'https://api.openai.com/v1/responses');
 const payload=JSON.parse(calls[0][1].body);assert.equal(payload.text.format.strict,true);assert.equal(payload.store,false);delete process.env.OPENAI_API_KEY;
});
test('missing AI configuration returns a real setup error instead of fabricated content',async()=>{delete process.env.OPENAI_API_KEY;await assert.rejects(G.generate({}),/OPENAI_API_KEY/);});
