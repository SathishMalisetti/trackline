const {test}=require('node:test'), assert=require('node:assert/strict');
process.env.SUPABASE_URL='https://test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY='sb_publishable_test';
process.env.SUPABASE_SERVICE_ROLE_KEY='server-only';
let replies,calls;
require.cache[require.resolve('node-fetch')]={exports:async (...args)=>{
  calls.push(args);const body=replies.shift();if(body===undefined)throw new Error('Unexpected network request');
  return {ok:true,status:200,json:async()=>body};
}};
const handler=require('../family-credentials');
const {matchesSecret}=require('../shared/credentials');
function request(body){return {method:'POST',headers:{authorization:'Bearer token'},query:{},body:{familyId:'FAMILY1',...body}};}
function auth(role='parent'){return [{id:'u1',email:'p@example.com'},[{family_id:'FAMILY1',member_id:'p1',role}]];}
test('family password is salted server-side, with an unrelated session version',async()=>{
  calls=[];replies=[...auth(),null];const context={};
  await handler(context,request({action:'password',password:'new password'}));
  assert.equal(context.res.status,200);
  const body=JSON.parse(calls.at(-1)[1].body);
  assert.ok(await matchesSecret('new password',body.p_hash));
  assert.match(body.p_version,/^[a-f0-9]{64}$/);
  assert.equal(body.p_token_hash,null);
  assert.ok(!context.res.body.includes('scrypt:'));
});
test('reset PIN verifies member ownership and children cannot reset credentials',async()=>{
  calls=[];replies=[...auth(),[{id:'kid1'}],null];const context={};
  await handler(context,request({action:'reset-pin',memberId:'kid1'}));
  assert.equal(context.res.status,200);
  assert.ok(calls.at(-1)[0].includes('family_id=eq.FAMILY1'));
  assert.equal(JSON.parse(calls.at(-1)[1].body).pin_hash,null);
  calls=[];replies=auth('kid');
  await handler(context,request({action:'password',password:'password'}));
  assert.equal(context.res.status,403);assert.equal(calls.length,2);
});
