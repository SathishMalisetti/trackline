const {test}=require('node:test'),assert=require('node:assert/strict');
const S=require('../shared/push-schedule');
const sub={id:'sub1',member_id:'parent',child_ids:['kid1'],timezone:'Australia/Melbourne',minutes_before:15};
const fixture=()=>({members:[{id:'parent',role:'parent',name:'Parent'},{id:'kid1',role:'kid',name:'Kid1'},{id:'kid2',role:'kid',name:'Kid2'},{id:'other-parent',role:'parent',name:'Other parent'}],events:[],tasks:[],logs:[],mutes:[]});
const event=(id,member='kid1',extra={})=>({id,member_id:member,title:'Swimming',recurrence:'once',date:'2026-10-20',start_min:17*60,...extra});
test('reminders use the selected family timezone and configurable lead time, including before midnight',()=>{
 const d=fixture();d.events=[event('e')];assert.equal(S.candidates(sub,d,new Date('2026-10-20T05:45:30Z')).length,1);
 assert.equal(S.candidates(sub,d,new Date('2026-10-20T05:44:59Z')).length,0);assert.equal(S.candidates(sub,d,new Date('2026-10-20T05:48:00Z')).length,0);
 assert.equal(S.candidates({...sub,minutes_before:30},d,new Date('2026-10-20T05:30:00Z')).length,1);
 d.events=[event('midnight','kid1',{date:'2026-10-21',start_min:5})];assert.equal(S.candidates(sub,d,new Date('2026-10-20T12:50:00Z')).length,1);
});
test('parents receive own plus selected kids; a child cannot target siblings or parents',()=>{
 const d=fixture();d.events=['parent','kid1','kid2','other-parent'].map(id=>event(id,id));const now=new Date('2026-10-20T05:45:00Z');
 assert.deepEqual(S.candidates(sub,d,now).map(c=>c.itemId),['parent','kid1']);assert.deepEqual(S.candidates({...sub,member_id:'kid1',child_ids:['parent','kid2']},d,now).map(c=>c.itemId),['kid1']);
 d.members=d.members.filter(m=>m.id!=='kid1');assert.deepEqual(S.candidates(sub,d,now).map(c=>c.itemId),['parent']);
});
test('weekly bounds, skipped and rescheduled occurrences match saved calendar rules',()=>{
 const e=event('weekly','kid1',{recurrence:'weekly',days:[1],skip_dates:['2026-10-20'],recurrence_end_date:'2026-10-31',occurrence_overrides:[{originalDate:'2026-10-20',newDate:'2026-10-21',newStart:600}]});
 assert.equal(S.eventOccurrences(e,'2026-10-20').length,0);assert.equal(S.eventOccurrences(e,'2026-10-21')[0].minute,600);assert.equal(S.eventOccurrences(e,'2026-11-03').length,0);
 assert.equal(S.eventOccurrences({...e,days:undefined,day:1,skip_dates:[]},'2026-10-20').length,1);
});
test('task daily/weekly/fortnightly/monthly/once recurrence and approval/start-date rules',()=>{
 const task={active:true,pending_approval:false,frequency:'fortnightly',start_date:'2026-10-12',days:[0,1]};
 assert.equal(S.taskDue(task,'2026-10-13'),true);assert.equal(S.taskDue(task,'2026-10-20'),false);assert.equal(S.taskDue(task,'2026-10-27'),true);
 assert.equal(S.taskDue({...task,frequency:'daily'},'2026-10-11'),false);assert.equal(S.taskDue({...task,pending_approval:true},'2026-10-13'),false);
 assert.equal(S.taskDue({...task,frequency:'monthly',day_of_month:31},'2027-02-28'),true);assert.equal(S.taskDue({...task,frequency:'once',due_date:'2026-10-20'},'2026-10-20'),true);
});
test('completed, untimed, inactive, deleted and muted items are never reminded; rescheduling invalidates old keys',()=>{
 const d=fixture(),now=new Date('2026-10-20T05:45:00Z');d.tasks=[{id:'task',member_id:'kid1',title:'Homework',frequency:'daily',due_time:'17:00',active:true}];
 assert.equal(S.candidates(sub,d,now).length,1);d.logs=[{chore_id:'task',date:'2026-10-20'}];assert.equal(S.candidates(sub,d,now).length,0);d.logs=[];
 d.mutes=[{subscription_id:'sub1',kind:'task',item_id:'task'}];assert.equal(S.candidates(sub,d,now).length,0);d.mutes=[];
 d.tasks[0].due_time=null;assert.equal(S.candidates(sub,d,now).length,0);d.tasks=[];d.events=[event('e')];const key=S.candidates(sub,d,now)[0].key;
 d.events[0].start_min=1080;assert.equal(S.candidates(sub,d,now).length,0);assert.notEqual(S.candidates(sub,d,new Date('2026-10-20T06:45:00Z'))[0].key,key);
 d.events=[];assert.equal(S.candidates(sub,d,now).length,0);
});
test('DST spring gap is skipped; fall repeated local time resolves to a single earlier occurrence',()=>{
 assert.equal(S.zonedInstant('2026-10-04',150,'Australia/Melbourne'),null);
 assert.equal(new Date(S.zonedInstant('2026-04-05',150,'Australia/Melbourne')).toISOString(),'2026-04-04T15:30:00.000Z');
 assert.equal(S.zonedInstant('2026-10-20',1440,'Australia/Melbourne'),null);
});
