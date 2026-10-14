const crypto=require('node:crypto');
const A=require('../shared/admin');
const {assertOrigin}=require('../shared/family-session');
module.exports=async(context,req)=>{try{
 if(req.method!=='GET')assertOrigin(req);
 const s=await A.session(req),b=req.body||{};
 if(req.method==='DELETE'){
  const t=A.token(req);if(t)await A.db('platform_admin_sessions?token_hash=eq.'+A.digest(t),{method:'DELETE'});
  context.res=A.response(200,{ok:true},{'Set-Cookie':A.cookie('',true)});return;
 }
 if(req.method==='GET'){
  context.res=A.response(200,{signedIn:!!s,unlocked:!!s&&Date.parse(s.unlocked_until)>Date.now(),admin:s?A.publicAdmin(s.admin):null});return;
 }
 if(req.method!=='POST')throw A.fail('Method not allowed.',405);
 if(b.action==='lock'){
  if(s)await A.db('platform_admin_sessions?token_hash=eq.'+s.token_hash,{method:'PATCH',body:JSON.stringify({unlocked_until:null})});
  context.res=A.response(200,{ok:true});return;
 }
 let admin,value,mode,stored,rawToken;
 if(b.action==='login'){
  if(typeof b.username!=='string'||!/^[a-z][a-z0-9_-]{2,31}$/i.test(b.username)||typeof b.password!=='string'||b.password.length>128)throw A.fail('Enter your username and password.');
  [admin]=await A.db('platform_admins?username=eq.'+encodeURIComponent(b.username.toLowerCase())+'&select=id,username,password_hash,enabled');
  value=b.password;mode='password';stored=admin?.password_hash;rawToken=crypto.randomBytes(32).toString('hex');
 }else{
  if(!s)throw A.fail('Sign in again.',401);
  [admin]=await A.db('platform_admins?id=eq.'+s.admin.id+'&select=id,username,password_hash,pin_hash,enabled');
  mode=b.action==='pin'?'pin':b.action==='reauth'?'reauth':null;
  if(!mode)throw A.fail('Unknown sign-in action.');
  value=mode==='pin'?b.pin:b.password;stored=mode==='pin'?admin.pin_hash:admin.password_hash;
  if(typeof value!=='string'||value.length>128||(mode==='pin'&&!/^\d{4}$/.test(value)))throw A.fail(mode==='pin'?'Enter your 4-digit PIN.':'Enter your password.');
 }
 if(!admin){await A.hashSecret(value);throw A.fail('Incorrect credentials.',401);}
 const result=await A.rpc('admin_auth_attempt',{p_username:admin.username,p_token:rawToken?A.digest(rawToken):s.token_hash,p_observed:stored,p_matches:await A.matchesSecret(value,stored),p_mode:mode});
 if(result.status!==200)throw A.fail(result.status===429?'Too many attempts. Try again in five minutes.':'Incorrect credentials.',result.status);
 await A.audit(admin,'auth.'+mode,null);
 context.res=A.response(200,{ok:true},rawToken?{'Set-Cookie':A.cookie(rawToken)}:{});
 }catch(e){context.res=A.response(e.status||503,{error:e.status?e.message:'Administrator sign-in is unavailable.'});}};
