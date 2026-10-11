const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.SUPABASE_URL='https://test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
process.env.SUPABASE_SERVICE_ROLE_KEY='server-only';
let responses,calls;
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{
  calls.push(args);const body=responses.shift();assert.notEqual(body,undefined,'unexpected service call');
  return {ok:true,status:200,json:async()=>body};
}};
const handler=require('../parent-password');
const {digest}=require('../shared/family-session');
const {hashSecret}=require('../shared/credentials');
const token='a'.repeat(64);
const device={token_hash:digest(token),family_id:'FAMILY1',password_version:'family-version',member_id:null};
const family={id:'FAMILY1',password_hash:'family-version'};
async function run(body,data,profile=null){
  calls=[];responses=[[profile?{...device,member_id:profile.id,pin_version:profile.pin_hash}:device],[family],...(profile?[[profile]]:[]),...data];
  const context={};await handler(context,{method:'POST',headers:{cookie:`__Host-trackline-family=${token}`,'x-trackline-session':'family',host:'app.example',origin:'https://app.example'},body:{familyId:'FAMILY1',memberId:'p1',...body},query:{}});return context.res;
}
test('parent fallback verifies a salted password in a scoped family session',async()=>{
  const hash=await hashSecret('personal-password');
  const result=await run({password:'personal-password'},[[{id:'p1'}],[{password_hash:hash}],{status:200,needsPin:false}]);
  assert.equal(result.status,200);assert.ok(!result.body.includes(hash));
  const payload=JSON.parse(calls.at(-1)[1].body);assert.equal(payload.p_matches,true);assert.equal(payload.p_token_hash,digest(token));
});
test('incorrect parent password delegates the failure to the database attempt limiter',async()=>{
  const hash=await hashSecret('personal-password');
  const result=await run({password:'wrong'},[[{id:'p1'}],[{password_hash:hash}],{status:403,error:'Incorrect parent password.'}]);
  assert.equal(result.status,403);assert.equal(JSON.parse(calls.at(-1)[1].body).p_matches,false);
});
test('family access alone and child PIN sessions cannot set parent passwords',async()=>{
  assert.equal((await run({action:'set',password:'personal-password'},[])).status,403);
  assert.equal(calls.length,2);
  assert.equal((await run({action:'set',password:'personal-password'},[],{id:'kid1',role:'kid',pin_hash:'kid-pin'})).status,403);
  assert.equal(calls.length,3);
});
test('parent password lookup rejects a profile outside the current family',async()=>{
  assert.equal((await run({password:'personal-password'},[[]])).status,403);
  assert.match(calls.at(-1)[0],/family_id=eq.FAMILY1/);
});
test('unlocked parents can set salted personal passwords, distinct from family passwords',async()=>{
  const parent={id:'p1',role:'parent',pin_hash:'parent-pin'},hash=await hashSecret('family-password');
  const secureFamily={...family,login_password_version:family.password_hash,login_password_hash:hash};
  const result=await run({action:'set',password:'personal-password'},[[secureFamily],{status:200,ok:true}],parent);
  assert.equal(result.status,200);assert.match(JSON.parse(calls.at(-1)[1].body).p_password_hash,/^scrypt:/);
  assert.equal((await run({action:'set',password:'family-password'},[[secureFamily]],parent)).status,400);
});
