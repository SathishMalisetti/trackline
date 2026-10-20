const {test}=require('node:test'),assert=require('node:assert/strict');
process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='server';process.env.SUPABASE_PUBLISHABLE_KEY='public';
let calls=[],replies=[];
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{calls.push(args);const r=replies.shift();if(!r)throw Error('Unexpected request');return{ok:(r.status||200)<400,status:r.status||200,json:async()=>r.body};}};
const handler=require('../push-settings'),P=require('../shared/push-store');
const id='11111111-1111-4111-8111-111111111111',key='a'.repeat(64),origin='https://victorious-field-093009200.7.azurestaticapps.net';
const auth=(role='parent')=>[{body:{id:'user',email:'user@test.com'}},{body:[{family_id:'F1',member_id:'m1',role}]}];
const config={enabled:true,public_key:'public-only',private_key:'never-return-this',worker_secret:'b'.repeat(64),app_origin:origin};
async function run(body,rows=[],query={familyId:'F1'},method='POST'){calls=[];replies=rows;const c={};await handler(c,{method,headers:{authorization:'Bearer test',origin},query,body:{familyId:'F1',deviceKey:key,...body}});return c.res;}
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{auth:'a'.repeat(22),p256dh:'B'.repeat(87)}};
test('push endpoint allowlist rejects SSRF, credentials and malformed keys',()=>{
 assert.equal(P.validSubscription(subscription).endpoint,subscription.endpoint);
 for(const endpoint of ['https://127.0.0.1/','http://fcm.googleapis.com/fcm','https://evil.test/fcm','https://fcm.googleapis.com.evil.test/','https://user:pass@fcm.googleapis.com/','https://fcm.googleapis.com:444/'])assert.throws(()=>P.validSubscription({...subscription,endpoint}));
 assert.throws(()=>P.validSubscription({...subscription,keys:{auth:'bad',p256dh:'bad'}}));
});
test('configuration returns only the public VAPID key, never worker/private secrets',async()=>{
 const r=await run({},[...auth(),{body:[config]}],{familyId:'F1'},'GET');assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),{publicKey:'public-only',appOrigin:origin});
});
test('parents can select only their own children and children cannot select anyone else',async()=>{
 const b={action:'subscribe',subscription,minutesBefore:15,timezone:'Australia/Melbourne',childIds:['kid1']};
 let r=await run(b,[...auth('kid'),{body:[config]}]);assert.equal(r.status,403);assert.equal(calls.length,3);
 r=await run(b,[...auth(),{body:[config]},{body:[{id:'someone-else'}]}]);assert.equal(r.status,403);
 r=await run(b,[...auth(),{body:[config]},{body:[{id:'kid1'}]},{body:id}]);assert.equal(r.status,200);
 const saved=JSON.parse(calls.at(-1)[1].body).p_data;assert.equal(saved.family_id,'F1');assert.equal(saved.member_id,'m1');assert.equal(saved.auth_user_id,'user');assert.deepEqual(saved.child_ids,['kid1']);assert.notEqual(saved.device_key_hash,key);
});
test('invalid timing/timezone and cross-family requests fail before subscription writes',async()=>{
 for(const extra of [{minutesBefore:0},{minutesBefore:1441},{timezone:'not-a-timezone'}]){const r=await run({action:'subscribe',subscription,minutesBefore:15,timezone:'UTC',childIds:[],...extra},[...auth(),{body:[config]}]);assert.equal(r.status,400);assert.equal(calls.length,3);}
 const r=await run({action:'status',familyId:'OTHER'},auth(),{});assert.equal(r.status,403);assert.equal(calls.length,2);
});
test('device revocation is available after logout but is scoped by unguessable device capability',async()=>{
 const r=await run({action:'revoke',id},[{body:null}]);assert.equal(r.status,200);assert.equal(calls.length,1);assert.ok(calls[0][0].includes('id=eq.'+id+'&device_key_hash=eq.'+P.digest(key)));
 const denied=await run({action:'revoke',id,deviceKey:'bad'},[]);assert.equal(denied.status,400);assert.equal(calls.length,0);
});
test('status is scoped to current member and device, returning preferences rather than endpoint secrets',async()=>{
 const row={id,enabled:true,auth_user_id:'user',minutes_before:30,child_ids:[],timezone:'UTC',expires_at:new Date(Date.now()+86400000).toISOString(),endpoint:'never-return',keys:{auth:'secret'}};
 const r=await run({action:'status',id},[...auth(),{body:[row]},{body:[]}]);assert.equal(r.status,200);assert.ok(!r.body.includes('never-return'));assert.ok(calls[2][0].includes('family_id=eq.F1&member_id=eq.m1'));assert.equal(JSON.parse(r.body).subscription.minutesBefore,30);
});
test('item opt-out cannot affect another profile or subscription',async()=>{
 const row={id,child_ids:[]};const r=await run({action:'item',id,kind:'task',itemId:'other-task',enabled:false},[...auth('kid'),{body:[row]},{body:[{member_id:'kid2'}]}]);assert.equal(r.status,403);assert.equal(calls.length,4);
});
test('delivery verification blocks an item completed after the push was queued',async()=>{
 const schedule=require('../shared/push-schedule'),start=new Date(Date.now()+15*60000),date=start.toISOString().slice(0,10),time=start.toISOString().slice(11,16);
 const sub={id,family_id:'F1',member_id:'m1',timezone:'UTC',minutes_before:15,child_ids:[],enabled:true};
 const task={id:'task1',member_id:'m1',title:'Homework',frequency:'daily',due_time:time,active:true};
 const data={members:[{id:'m1',name:'Child',role:'kid'}],events:[],tasks:[task],logs:[],mutes:[]};
 const candidate=schedule.candidates(sub,data,new Date(Date.parse(date+'T'+time+':00Z')-15*60000))[0];
 const body={action:'verify',id,kind:'task',itemId:'task1',start:candidate.start,key:candidate.key};
 let r=await run(body,[{body:[sub]},{body:true},{body:data.members},{body:[]},{body:[task]},{body:[]},{body:[]}]);assert.equal(r.status,200);assert.equal(JSON.parse(r.body).valid,true);
 r=await run(body,[{body:[sub]},{body:true},{body:data.members},{body:[]},{body:[task]},{body:[{chore_id:'task1',date}]},{body:[]}]);assert.equal(JSON.parse(r.body).valid,false);
});
