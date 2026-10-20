const P=require('./push-store');
async function pages(path){const rows=[];for(let offset=0;offset<100000;offset+=1000){const batch=await P.service(path+'&limit=1000&offset='+offset);rows.push(...batch);if(batch.length<1000)return rows;}throw Error('Reminder dataset exceeds worker limit');}
async function familyData(id){const f=encodeURIComponent(id);const [members,events,tasks,logs,mutes]=await Promise.all([
 pages('members?family_id=eq.'+f+'&select=id,name,role&order=id'),
 pages('events?family_id=eq.'+f+'&select=id,member_id,title,recurrence,day,days,date,skip_dates,occurrence_overrides,start_min,recurrence_end_date&order=id'),
 pages('chores?family_id=eq.'+f+'&active=eq.true&select=id,member_id,title,frequency,days,day_of_month,start_date,due_date,due_time,active,pending_approval&order=id'),
 pages('chore_logs?family_id=eq.'+f+'&date=gte.'+new Date(Date.now()-2*86400000).toISOString().slice(0,10)+'&select=chore_id,date&order=id'),
 // Mutes are loaded separately per subscription, without leaking another family's records.
 Promise.resolve([])
]);return{members,events,tasks,logs,mutes};}
module.exports={familyData};
