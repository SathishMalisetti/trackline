const {protect} = require('../shared/auth');
const {service, newToken} = require('../shared/family-session');
const {hashSecret} = require('../shared/credentials');
module.exports = protect(async (context,req)=>{
  const {action, familyId, memberId, password} = req.body || {};
  if (action === 'reset-pin') {
    if (!memberId) throw Object.assign(new Error('Choose a member.'),{status:400});
    await service('members?id=eq.'+encodeURIComponent(memberId)+'&family_id=eq.'+encodeURIComponent(familyId),{method:'PATCH',body:JSON.stringify({pin_hash:null,pin_failed_attempts:0,pin_locked_until:null})});
  } else if (action === 'password') {
    if (typeof password !== 'string' || password.length < 4 || password.length > 128) throw Object.assign(new Error('Family password needs to be 4–128 characters.'),{status:400});
    await service('rpc/set_family_password_secure',{method:'POST',body:JSON.stringify({p_family_id:familyId,p_hash:await hashSecret(password),p_version:newToken(),p_token_hash:req.auth.familySession ? req.auth.familySession.token_hash : null})});
  } else throw Object.assign(new Error('Unknown credential action.'),{status:400});
  context.res={status:200,body:JSON.stringify({ok:true})};
},{parent:true});
