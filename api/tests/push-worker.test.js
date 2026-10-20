const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='server';let calls=[],replies=[],sent=[];
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{calls.push(args);const r=replies.shift();if(r===undefined)throw Error('Unexpected database request');return{ok:true,status:200,json:async()=>r};}};
require.cache[require.resolve('web-push')]={exports:{sendNotification:async(...args)=>sent.push(args)}};
const worker=require('../push-reminder-worker'),schedule=require('../shared/push-schedule');
const secret='b'.repeat(64),config={enabled:true,worker_secret:secret,public_key:'public',private_key:'private',app_origin:'https://trackline.test'};
function signed(value=secret,offset=0){const minute=String(Math.floor(Date.now()/60000)+offset),nonce='11111111-1111-4111-8111-111111111111';return{'x-trackline-push-minute':minute,'x-trackline-push-nonce':nonce,'x-trackline-push-proof':crypto.createHmac('sha256',value).update(minute+':'+nonce).digest('hex')};}
async function run(headers={},rows=[]){calls=[];replies=rows;sent=[];const c={};await worker(c,{method:'POST',headers});return c.res;}
test('worker rejects browser and arbitrary credentials; secrets never appear in response',async()=>{
 let r=await run({authorization:'Bearer human'});assert.equal(r.status,401);assert.equal(calls.length,0);
 r=await run(signed('a'.repeat(64)),[[config]]);assert.equal(r.status,401);assert.equal(calls.length,1);assert.ok(!r.body.includes(secret));
 r=await run(signed(secret,-3));assert.equal(r.status,401);assert.equal(calls.length,0);
});
test('worker sends only claimed reminders and records outcomes using the lease',async()=>{
 // Use a real occurrence due 15 minutes from the current UTC minute.
 const start=new Date(Date.now()+15*60000),date=start.toISOString().slice(0,10),minute=start.getUTCHours()*60+start.getUTCMinutes();
 const sub={id:'11111111-1111-4111-8111-111111111111',family_id:'F1',member_id:'kid',child_ids:[],timezone:'UTC',minutes_before:15,endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{auth:'a'.repeat(22),p256dh:'B'.repeat(87)}};
 const data=[[{id:'kid',name:'Kid',role:'kid'}],[{id:'event',member_id:'kid',title:'Swimming',recurrence:'once',date,start_min:minute}],[],[],[]];
 const r=await run(signed(),[[config],[sub],...data,'lease',null]);assert.equal(r.status,200);assert.equal(sent.length,1);assert.equal(JSON.parse(sent[0][1]).binding,sub.id);assert.ok(sent[0][2].TTL<=300);assert.equal(sent[0][2].vapidDetails.privateKey,'private');assert.ok(!r.body.includes('private'));assert.ok(calls.at(-1)[0].includes('push_finish_delivery'));
});
