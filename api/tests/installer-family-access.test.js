const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.SUPABASE_URL='https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY='server-only';
let responses,calls;
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{
  calls.push(args);const body=responses.shift();assert.notEqual(body,undefined,'unexpected database call');
  return {ok:true,status:200,json:async()=>body};
}};
const members=require('../family-members'),pair=require('../device-pair');
const {digest}=require('../shared/family-session');
const token='a'.repeat(64), family={id:'FAMILY1',password_hash:'legacy-hash'}, device={token_hash:digest(token),family_id:'FAMILY1',password_version:'legacy-hash',member_id:null};
async function run(handler,body,data){
  calls=[];responses=data;const log=()=>{};log.error=()=>{};const context={log};
  await handler(context,{method:'POST',headers:{cookie:`__Host-trackline-family=${token}`,'x-trackline-session':'family',host:'app.example',origin:'https://app.example'},body,query:{}});return context.res;
}
test('family-connected installer may list only member names and roles without a parent email or PIN',async()=>{
  const result=await run(members,{familyId:'FAMILY1',passwordHash:'legacy-hash'},[[device],[family],[family],[{id:'kid1',name:'Kid',role:'kid',pin_hash:'private'}]]);
  assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.body),{members:[{id:'kid1',name:'Kid',role:'kid'}]});
});
test('family-connected installer may pair a member with an opaque device token',async()=>{
  const result=await run(pair,{familyId:'FAMILY1',passwordHash:'legacy-hash',memberId:'kid1'},[[device],[family],[family],[{id:'kid1'}],[]]);
  assert.equal(result.status,200);const body=JSON.parse(result.body),stored=JSON.parse(calls.at(-1)[1].body);
  assert.equal(stored.family_id,'FAMILY1');assert.equal(stored.member_id,'kid1');assert.equal(stored.device_token_hash,digest(body.deviceToken));
  assert.notEqual(stored.device_token_hash,body.deviceToken);
});
test('installer family access cannot pair another family',async()=>{
  const result=await run(pair,{familyId:'OTHER',passwordHash:'legacy-hash',memberId:'kid1'},[[device],[family]]);
  assert.equal(result.status,403);assert.equal(calls.length,2);
});
test('installer must have a valid family session before listing or pairing',async()=>{
  assert.equal((await run(pair,{familyId:'FAMILY1',passwordHash:'legacy-hash',memberId:'kid1'},[[]])).status,401);
  assert.equal(calls.length,1);
});
test('pairing rejects a member that does not belong to the family',async()=>{
  const result=await run(pair,{familyId:'FAMILY1',passwordHash:'legacy-hash',memberId:'foreign'},[[device],[family],[family],[]]);
  assert.equal(result.status,404);assert.equal(calls.length,4);
});
