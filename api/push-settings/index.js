const {protect}=require('../shared/auth');
const {assertOrigin}=require('../shared/family-session');
const P=require('../shared/push-store');
const scoped=protect(async(context,req)=>{
 const b=req.body||{},membership=req.membership,familyId=membership.family_id,memberId=membership.member_id;
 if(req.method==='GET'){
  const c=await P.config(true);context.res=P.response(200,{publicKey:c.public_key,appOrigin:c.app_origin});return;
 }
 assertOrigin(req);
 const hash=P.deviceKey(b.deviceKey),action=b.action;
 let sub;
 if(b.id){[sub]=await P.service('push_subscriptions?id=eq.'+P.id(b.id)+'&device_key_hash=eq.'+hash+'&family_id=eq.'+encodeURIComponent(familyId)+'&member_id=eq.'+encodeURIComponent(memberId)+'&select=*');}
 if(action==='status'){
  const mutes=sub?await P.service('push_item_mutes?subscription_id=eq.'+sub.id+'&select=kind,item_id'):[];
  const bound=sub&&(req.auth.familySession?sub.session_hash===req.auth.familySession.token_hash:sub.auth_user_id===req.auth.user.id);
  context.res=P.response(200,{subscription:sub?{id:sub.id,enabled:!!(bound&&sub.enabled&&new Date(sub.expires_at)>new Date()),minutesBefore:sub.minutes_before,childIds:sub.child_ids,timezone:sub.timezone}:null,mutes});return;
 }
 if(action==='subscribe'){
  const c=await P.config(true);
  // Preview subscriptions would point to a different service-worker origin.
  if(req.headers.origin!==c.app_origin)throw P.fail('Enable notifications from the published Trackline website.',403);
  const subscription=P.validSubscription(b.subscription),minutes=b.minutesBefore;
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440||typeof b.timezone!=='string'||b.timezone.length>100)throw P.fail('Choose 1–1440 minutes and a valid schedule timezone.');
  try{new Intl.DateTimeFormat('en',{timeZone:b.timezone}).format();}catch{throw P.fail('Choose a valid schedule timezone.');}
  if(!Array.isArray(b.childIds)||b.childIds.length>50||!b.childIds.every(v=>typeof v==='string'&&v.length<=128))throw P.fail('Select valid children.');
  const children=[...new Set(b.childIds)];
  if(membership.role!=='parent'&&children.length)throw P.fail('Children can only receive their own reminders.',403);
  if(children.length){const members=await P.service('members?family_id=eq.'+encodeURIComponent(familyId)+'&role=eq.kid&select=id');if(children.some(v=>!members.some(m=>m.id===v)))throw P.fail('Select children from your own family.',403);}
  const data={...subscription,device_key_hash:hash,family_id:familyId,member_id:memberId,session_hash:req.auth.familySession?.token_hash||null,auth_user_id:req.auth.familySession?null:req.auth.user.id,
   minutes_before:minutes,child_ids:children,timezone:b.timezone,expires_at:req.auth.familySession?.expires_at||new Date(Date.now()+30*86400000).toISOString()};
  const saved=await P.rpc('push_save_subscription',{p_data:data});context.res=P.response(200,{id:saved,enabled:true});return;
 }
 if(action==='item'){
  if(!sub)throw P.fail('Enable notifications on this device first.',409);
  if(!['event','task'].includes(b.kind)||typeof b.itemId!=='string'||!b.itemId||b.itemId.length>128||typeof b.enabled!=='boolean')throw P.fail('Choose a valid reminder.');
  const [item]=await P.service((b.kind==='event'?'events':'chores')+'?id=eq.'+encodeURIComponent(b.itemId)+'&family_id=eq.'+encodeURIComponent(familyId)+'&select=member_id');
  if(!item||!(item.member_id===memberId||membership.role==='parent'&&sub.child_ids.includes(item.member_id)))throw P.fail('This reminder is not selected for this device.',403);
  const path='push_item_mutes?subscription_id=eq.'+sub.id+'&kind=eq.'+b.kind+'&item_id=eq.'+encodeURIComponent(b.itemId);
  if(b.enabled)await P.service(path,{method:'DELETE'});
  else await P.service('push_item_mutes?on_conflict=subscription_id,kind,item_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates'},body:JSON.stringify({subscription_id:sub.id,kind:b.kind,item_id:b.itemId})});
  context.res=P.response(200,{ok:true});return;
 }
 throw P.fail('Unknown notification action.');
});
module.exports=async(context,req)=>{
 try{
  // Revocation needs only this browser's secret capability, even after its login expires.
  if(req.method==='POST'&&req.body?.action==='verify'){
   assertOrigin(req);const b=req.body,hash=P.deviceKey(b.deviceKey);
   if(!['event','task'].includes(b.kind)||typeof b.itemId!=='string'||b.itemId.length>128||typeof b.key!=='string'||!/^[a-f0-9]{64}$/.test(b.key)||!Number.isFinite(b.start))throw P.fail('Invalid reminder.');
   if(b.start<=Date.now()||b.start>Date.now()+2*86400000){context.res=P.response(200,{valid:false});return;}
   const [sub]=await P.service('push_subscriptions?id=eq.'+P.id(b.id)+'&device_key_hash=eq.'+hash+'&select=*');let valid=false;
   if(sub&&await P.rpc('push_subscription_active',{s:sub})){
    const {familyData}=require('../shared/push-family'),{candidates}=require('../shared/push-schedule');
    const data=await familyData(sub.family_id);data.mutes=await P.service('push_item_mutes?subscription_id=eq.'+sub.id+'&select=subscription_id,kind,item_id');
    valid=Date.now()<b.start&&candidates(sub,data,new Date(b.start-sub.minutes_before*60000)).some(c=>c.key===b.key&&c.kind===b.kind&&c.itemId===b.itemId);
   }
   context.res=P.response(200,{valid});return;
  }
  if(req.method==='POST'&&req.body?.action==='revoke'){
   assertOrigin(req);const hash=P.deviceKey(req.body.deviceKey);
   await P.service('push_subscriptions?id=eq.'+P.id(req.body.id)+'&device_key_hash=eq.'+hash,{method:'PATCH',body:JSON.stringify({enabled:false,updated_at:new Date().toISOString()})});
   context.res=P.response(200,{ok:true});return;
  }
  if(!['GET','POST'].includes(req.method))throw P.fail('Method not allowed.',405);
  await scoped(context,req);
 }catch(e){context.res=P.response(e.status||503,{error:e.status?e.message:'Background reminders are unavailable. Please retry.'});}
};
