const crypto = require('node:crypto');
const { protect } = require('../shared/auth');
const { service } = require('../shared/family-session');
module.exports = protect(async (context, req) => {
  const {kidId,topicId} = req.body || {};
  if(typeof kidId!=='string' || typeof topicId!=='string' || !topicId || topicId.length>128) throw Object.assign(new Error('Choose a study topic and child.'), {status:400});
  const [member]=await service(`members?id=eq.${encodeURIComponent(kidId)}&family_id=eq.${encodeURIComponent(req.membership.family_id)}&select=role`);
  const [topic]=await service(`topics?id=eq.${encodeURIComponent(topicId)}&select=id`);
  if(!member || member.role!=='kid' || !topic) throw Object.assign(new Error('Study topic or child was not found.'), {status:403});
  // Starting a topic must never replace a saved exam result or reset attempts.
  await service('topic_progress?on_conflict=member_id,topic_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({id:crypto.randomUUID(),family_id:req.membership.family_id,member_id:kidId,topic_id:topicId,status:'studying',attempt_count:0,updated_at:new Date().toISOString()})});
  context.res={status:200,headers:{'Content-Type':'application/json'},body:'{"ok":true}'};
});
