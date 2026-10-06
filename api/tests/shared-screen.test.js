const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
process.env.SUPABASE_URL='https://test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY='public-test';
process.env.SUPABASE_SERVICE_ROLE_KEY='server-only';
let replies,calls;
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{
 calls.push(args);const r=replies.shift();if(!r)throw Error('Unexpected call');
 return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.body};
}};
const task=require('../child-task');const data=require('../family-data');const progress=require('../study-progress');
const membership={family_id:'F1',member_id:'kid1',role:'kid'};
const user={id:'user',email:'test@example.com'};
const req=body=>({method:'POST',headers:{authorization:'Bearer token'},query:{},body:{familyId:'F1',...body}});
async function run(handler,request,rows){calls=[];replies=[{status:200,body:user},{status:200,body:[membership]},...rows.map(body=>({status:200,body}))];const log=()=>{};log.error=()=>{};const ctx={log};await handler(ctx,request);return ctx.res;}
test('child task saves only their own pending task, without granting points or approval',async()=>{
 const r=await run(task,req({title:'Read book',frequency:'once',memberId:'kid1',points:100,pendingApproval:false}),[[{role:'kid',can_add_tasks:true}],[]]);
 assert.equal(r.status,201);const row=JSON.parse(calls[3][1].body);assert.equal(row.member_id,'kid1');assert.equal(row.family_id,'F1');assert.equal(row.pending_approval,true);assert.equal(row.points,0);
});
test('disabled task permission and another child profile cannot create tasks',async()=>{
 let r=await run(task,req({title:'Read',frequency:'once'}),[[{role:'kid',can_add_tasks:false}]]);assert.equal(r.status,403);assert.equal(calls.length,3);
 r=await run(task,req({title:'Read',frequency:'once',memberId:'kid2'}),[]);assert.equal(r.status,403);assert.equal(calls.length,2);
});
test('refresh returns stored permissions, year level, approval and study progress',async()=>{
 const r=await run(data,{...req({}),method:'GET',query:{familyId:'F1'}},[
 {family:{id:'F1',passwordHash:'private'},members:[{id:'kid1',pinHash:'private'}],events:[],chores:[{id:'c1'}]},
 [{id:'kid1',year_level:'4',can_add_tasks:false,can_add_shopping:true}],
 [{id:'c1',pending_approval:true,icon:'book'}],
 [{id:'tp1',member_id:'kid1',topic_id:'t1',status:'completed',exam_score:80,attempt_count:2},{id:'tp2',member_id:'kid2',topic_id:'t2',status:'studying'}],[],[]]);
 assert.equal(r.status,200);const saved=JSON.parse(r.body);assert.equal(saved.members[0].yearLevel,'4');assert.equal(saved.members[0].canAddTasks,false);assert.equal(saved.chores[0].pendingApproval,true);assert.equal(saved.topicProgress.length,1);assert.equal(saved.topicProgress[0].examScore,80);assert.equal(saved.topicProgress[0].attemptCount,2);assert.equal(saved.members[0].pinHash,undefined);
});
test('starting study persists without overwriting completed progress or accepting client scores',async()=>{
 const r=await run(progress,req({kidId:'kid1',topicId:'t1',examScore:100,status:'completed'}),[[{role:'kid'}],[{id:'t1'}],[]]);
 assert.equal(r.status,200);const write=calls[4];assert.match(write[1].headers.Prefer,/ignore-duplicates/);const row=JSON.parse(write[1].body);assert.equal(row.status,'studying');assert.equal(row.exam_score,undefined);
});
test('child cannot save study progress for another profile',async()=>{
 const r=await run(progress,req({kidId:'kid2',topicId:'t1'}),[]);assert.equal(r.status,403);assert.equal(calls.length,2);
});
test('shared-screen menu locks the session and selects the requested member; child toggle is honoured',()=>{
 const html=fs.readFileSync(require('node:path').join(__dirname,'../../app/index.html'),'utf8');
 const fn=name=>html.match(new RegExp('function '+name+'\\([^]*?\\n}'))[0];
 let locked=false;const ctx={tracklineAuth:{sessionMode:'family',membership:{member_id:'parent'},lock:()=>{locked=true}},ui:{profileId:'kid1'},isLoggedIn:()=>true,isParentLoggedIn:()=>false,memberById:()=>({canAddTasks:true})};vm.createContext(ctx);
 vm.runInContext(fn('openLogin')+'\n'+fn('kidsCanAddTasks'),ctx);ctx.openLogin('kid1');assert.equal(locked,true);assert.equal(ctx.tracklineAuth.selectedMemberId,'kid1');assert.equal(ctx.kidsCanAddTasks(),true);ctx.memberById=()=>({canAddTasks:false});assert.equal(ctx.kidsCanAddTasks(),false);
});
