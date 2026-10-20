const crypto=require('node:crypto');
const addDate=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const weekday=date=>(new Date(date+'T12:00:00Z').getUTCDay()+6)%7;
const monday=date=>addDate(date,-weekday(date));
function localParts(instant,timezone){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(v=>[v.type,v.value]));
 return{date:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};
}
function zonedInstant(date,minute,timezone){
 if(!Number.isInteger(minute)||minute<0||minute>1439)return null;
 const target=Date.parse(date+'T00:00:00Z')+minute*60000;let guess=target;
 for(let i=0;i<4;i++){const p=localParts(new Date(guess),timezone);const represented=Date.parse(p.date+'T00:00:00Z')+p.minute*60000;const delta=target-represented;if(!delta)break;guess+=delta;}
 // Nonexistent spring-forward times are skipped; repeated fall-back times fire once at the earlier instant.
 const matches=[guess-7200000,guess-3600000,guess,guess+3600000,guess+7200000].filter(t=>{const p=localParts(new Date(t),timezone);return p.date===date&&p.minute===minute;});
 return matches.length?Math.min(...matches):null;
}
function taskDue(c,date){
 if(!c.active||c.pending_approval||c.start_date&&date<c.start_date)return false;
 if(c.frequency==='daily')return true;
 if(c.frequency==='once')return c.due_date===date;
 if(c.frequency==='monthly'){const d=new Date(date+'T12:00:00Z'),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();return d.getUTCDate()===Math.min(c.day_of_month||1,last);}
 if(!Array.isArray(c.days)||!c.days.includes(weekday(date)))return false;
 if(c.frequency==='weekly')return true;
 if(c.frequency==='fortnightly'){const weeks=Math.round((Date.parse(monday(date))-Date.parse(monday(c.start_date||date)))/604800000);return ((weeks%2)+2)%2===0;}
 return false;
}
function eventOccurrences(e,date){
 const result=[];const days=Array.isArray(e.days)?e.days:e.day==null?[]:[e.day];
 if((e.recurrence==='once'&&e.date===date)||(e.recurrence==='weekly'&&days.includes(weekday(date))&&(!e.recurrence_end_date||date<=e.recurrence_end_date)&&!(e.skip_dates||[]).includes(date)))result.push({date,minute:e.start_min,occurrence:date});
 for(const o of e.occurrence_overrides||[])if(o.newDate===date)result.push({date,minute:o.newStart,occurrence:o.originalDate});
 return result;
}
function candidates(sub,data,now=new Date()){
 const owner=data.members.find(m=>m.id===sub.member_id);if(!owner)return[];
 const allowed=new Set([owner.id]);if(owner.role==='parent')for(const id of sub.child_ids||[])if(data.members.some(m=>m.id===id&&m.role==='kid'))allowed.add(id);
 const muted=new Set((data.mutes||[]).filter(m=>m.subscription_id===sub.id).map(m=>m.kind+':'+m.item_id));
 const today=localParts(now,sub.timezone).date,results=[];
 function add(kind,item,occ){
  if(!allowed.has(item.member_id)||muted.has(kind+':'+item.id))return;
  if(kind==='task'&&data.logs.some(l=>l.chore_id===item.id&&l.date===occ.date))return;
  const start=zonedInstant(occ.date,occ.minute,sub.timezone);if(start===null)return;
  const trigger=start-sub.minutes_before*60000,late=now.getTime()-trigger;
  if(late<0||late>=180000||start<=now.getTime())return;
  const key=crypto.createHash('sha256').update(JSON.stringify([kind,item.id,occ.occurrence,start,sub.minutes_before])).digest('hex');
  const member=data.members.find(m=>m.id===item.member_id);
  results.push({key,kind,itemId:item.id,date:occ.date,start,title:kind==='task'?'Task reminder':'Calendar reminder',body:`${item.title} — ${member?.name||'Family member'} · in ${Math.max(1,Math.ceil((start-now.getTime())/60000))} min`});
 }
 for(let offset=0;offset<=2;offset++){
  const date=addDate(today,offset);
  for(const e of data.events)for(const occurrence of eventOccurrences(e,date))add('event',e,occurrence);
  for(const c of data.tasks)if(taskDue(c,date)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(c.due_time||'')){const [h,m]=c.due_time.split(':').map(Number);add('task',c,{date,minute:h*60+m,occurrence:date});}
 }
 return results;
}
module.exports={addDate,weekday,localParts,zonedInstant,taskDue,eventOccurrences,candidates};
