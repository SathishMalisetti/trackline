const fetch = require('node-fetch');
const crypto = require('node:crypto');
const {assertOrigin} = require('./family-session');
const {matchesSecret,hashSecret} = require('./credentials');
const name='__Host-trackline-admin';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const cookie=(value,clear=false)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear?0:2592000}`;
const token=req=>{const v=(req.headers?.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);return /^[a-f0-9]{64}$/.test(v||'')?v:null;};
function response(status,body,extra={}){return{status,body:JSON.stringify(body),headers:{'Content-Type':'application/json','Cache-Control':'no-store',...extra}};}
async function db(path,options={}){
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY,url=process.env.SUPABASE_URL;
 if(!key||!url)throw fail('Administration is not configured on the server.',503);
 const r=await fetch(url+'/rest/v1/'+path,{timeout:10000,...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...options.headers}});
 if(!r.ok){const e=await r.json().catch(()=>({}));if(r.status===409)throw fail('That record already exists or another operation is running.',409);throw fail('Could not complete the database operation. Please retry.',503);}
 return r.status===204?null:r.json();
}
const rpc=(name,body)=>db('rpc/'+name,{method:'POST',body:JSON.stringify(body)});
const insert=(table,row)=>db(table,{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
const patch=(table,id,row)=>db(table+'?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
async function session(req){
 const value=token(req);if(!value)return null;
 const [s]=await db('platform_admin_sessions?token_hash=eq.'+digest(value)+'&select=*');
 if(!s||Date.parse(s.expires_at)<=Date.now())return null;
 const [a]=await db('platform_admins?id=eq.'+s.admin_id+'&select=id,username,enabled,credential_version');
 if(!a||!a.enabled||a.credential_version!==s.credential_version)return null;
 return{...s,admin:a};
}
async function audit(admin,action,target,details={}){await insert('admin_audit_log',{admin_id:admin.id,action,target_id:target||null,details});}
function publicAdmin(a){return{id:a.id,username:a.username,enabled:a.enabled,created_at:a.created_at};}
function protect(handler){return async(context,req)=>{try{
 if(req.method!=='GET')assertOrigin(req);
 const s=await session(req);if(!s)throw fail('Sign in to platform administration.',401);
 if(!s.unlocked_until||Date.parse(s.unlocked_until)<=Date.now())throw fail('Enter your administrator PIN to continue.',423);
 req.admin=s.admin;req.adminSession=s;
 if(Date.parse(s.unlocked_until)-Date.now()<300000)await db('platform_admin_sessions?token_hash=eq.'+s.token_hash,{method:'PATCH',body:JSON.stringify({unlocked_until:new Date(Date.now()+900000).toISOString()})});
 await handler(context,req);
 }catch(e){context.res=response(e.status||503,{error:e.status?e.message:'Administration is temporarily unavailable.'});}};}
function recentPassword(req){const verified=Date.parse(req.adminSession.password_verified_at);if(!Number.isFinite(verified)||verified>Date.now()+60000||Date.now()-verified>300000)throw fail('Verify your password before this action.',428);}
function protectWorker(handler){return async(context,req)=>{try{
 const key=process.env.ADMIN_GENERATION_WORKER_KEY, supplied=req.headers?.['x-admin-worker-key'];
 if(!key||key.length<32||typeof supplied!=='string'||!crypto.timingSafeEqual(Buffer.from(digest(key)),Buffer.from(digest(supplied))))throw fail('Worker access denied.',401);
 await handler(context,req);
 }catch(e){context.res=response(e.status||503,{error:e.status?e.message:'Generation worker is unavailable.'});}};}
module.exports={db,rpc,insert,patch,session,token,digest,cookie,response,fail,protect,protectWorker,recentPassword,audit,publicAdmin,hashSecret,matchesSecret};
