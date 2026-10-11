const { protect } = require('../shared/auth');
const { service } = require('../shared/family-session');
const { hashSecret, matchesSecret } = require('../shared/credentials');
const reply = (context, result) => { context.res = { status:result.status, headers:{'Content-Type':'application/json'}, body:JSON.stringify(result) }; };
module.exports = protect(async (context, req) => {
  const { password, memberId, action } = req.body || {};
  if(typeof password !== 'string' || password.length<1 || password.length>128 || typeof memberId!=='string') throw Object.assign(new Error('Enter a parent password and choose a profile.'), {status:400});
  const session=req.auth.familySession;
  const familyId=session ? session.family_id : req.membership.family_id;
  if(action==='set') {
    const membership=req.auth.memberships.find(m=>m.family_id===familyId && m.role==='parent');
    if(!membership) throw Object.assign(new Error('Unlock a parent profile first.'),{status:403});
    if(password.length<8) throw Object.assign(new Error('Use at least 8 characters.'),{status:400});
    const [family]=await service(`families?id=eq.${encodeURIComponent(familyId)}&select=password_hash,login_password_hash,login_password_version`);
    const familyHash=family.login_password_version===family.password_hash ? family.login_password_hash : family.password_hash;
    if(await matchesSecret(password,familyHash)) throw Object.assign(new Error('Use a different password from the shared family password.'),{status:400});
    return reply(context,await service('rpc/set_parent_password',{method:'POST',body:JSON.stringify({p_family_id:familyId,p_member_id:memberId,p_password_hash:await hashSecret(password)})}));
  }
  if(!session) throw Object.assign(new Error('Access your family first to use a parent password.'),{status:403});
  const [member]=await service(`members?id=eq.${encodeURIComponent(memberId)}&family_id=eq.${encodeURIComponent(familyId)}&role=eq.parent&select=id`);
  if(!member) throw Object.assign(new Error('Parent profile required.'),{status:403});
  const [credential]=await service(`parent_credentials?member_id=eq.${encodeURIComponent(memberId)}&select=password_hash`);
  if(!credential){await hashSecret(password);throw Object.assign(new Error('Parent password not set. Use your PIN, or ask a parent to set a password in Settings.'),{status:403});}
  return reply(context,await service('rpc/check_parent_password',{method:'POST',body:JSON.stringify({p_token_hash:session.token_hash,p_member_id:memberId,p_observed_hash:credential.password_hash,p_matches:await matchesSecret(password,credential.password_hash)})}));
}, {familyEntry:true});
