const crypto = require('node:crypto');
const { protect } = require('../shared/auth');
const { service } = require('../shared/family-session');
module.exports = protect(async (context, req) => {
  if(req.membership.role !== 'kid') throw Object.assign(new Error('Use the parent task editor.'), {status:403});
  const familyId = req.membership.family_id, memberId = req.membership.member_id;
  const [member] = await service(`members?id=eq.${encodeURIComponent(memberId)}&family_id=eq.${encodeURIComponent(familyId)}&select=role,can_add_tasks`);
  if(!member || member.role !== 'kid' || member.can_add_tasks === false) throw Object.assign(new Error('Adding tasks is turned off. Ask a parent to enable it in Settings.'), {status:403});
  const {title,frequency,days=[],dayOfMonth=null,startDate=null,dueDate=null,dueTime=null} = req.body || {};
  const date = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)));
  if(typeof title !== 'string' || !title.trim() || title.length>200 || !['once','daily','weekly','fortnightly','monthly'].includes(frequency)
    || !Array.isArray(days) || days.length>7 || !days.every(d=>Number.isInteger(d)&&d>=0&&d<=6)
    || (dayOfMonth!==null && (!Number.isInteger(dayOfMonth)||dayOfMonth<1||dayOfMonth>31)) || !date(startDate) || !date(dueDate)
    || (dueTime!==null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime))) throw Object.assign(new Error('Enter valid task details.'), {status:400});
  const task={id:crypto.randomUUID(),memberId,title:title.trim(),frequency,days,dayOfMonth,startDate,dueDate,dueTime,points:0,active:true,pendingApproval:true};
  await service('chores', {method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({id:task.id,family_id:familyId,member_id:memberId,title:task.title,frequency,days,day_of_month:dayOfMonth,start_date:startDate,due_date:dueDate,due_time:dueTime,points:0,active:true,pending_approval:true})});
  context.res={status:201,headers:{'Content-Type':'application/json'},body:JSON.stringify({task})};
});
