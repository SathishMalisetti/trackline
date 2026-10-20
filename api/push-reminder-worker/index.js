const P=require('../shared/push-store');
const {candidates}=require('../shared/push-schedule');
const {familyData}=require('../shared/push-family');
module.exports=P.protectWorker(async(context,req)=>{
 try{
  const c=req.pushConfig;
  if(!c.private_key){context.res=P.response(200,{ready:false});return;}
  const webpush=require('web-push'),now=new Date(),started=Date.now(),cache=new Map();
  let after=null,sent=0,failed=0,claimed=0,more=false;
  outer:for(let page=0;page<10;page++){
   const subs=await P.rpc('push_live_subscriptions',{p_after:after,p_limit:100});
   for(const sub of subs){
    if(Date.now()-started>20000||claimed>=100){more=true;break outer;}
    if(!cache.has(sub.family_id))cache.set(sub.family_id,await familyData(sub.family_id));
    const data={...cache.get(sub.family_id),mutes:await P.service('push_item_mutes?subscription_id=eq.'+sub.id+'&select=subscription_id,kind,item_id')};
    const items=candidates(sub,data,now);
    for(const item of items){
     if(Date.now()-started>20000||claimed>=100){more=true;break outer;}
     const lease=await P.rpc('push_claim_delivery',{p_id:sub.id,p_key:item.key,p_kind:item.kind,p_item:item.itemId,p_date:item.date,p_minutes:sub.minutes_before});if(!lease)continue;
     claimed++;
     let ok=false,error=null;
     try{
      // Validate on send as well as registration: never use stored endpoints as arbitrary URLs.
      const subscription=P.validSubscription({endpoint:sub.endpoint,keys:sub.keys});
      await webpush.sendNotification(subscription,JSON.stringify({title:item.title,body:item.body,tag:item.key,expiresAt:item.start,url:'/',binding:sub.id,key:item.key,kind:item.kind,itemId:item.itemId,date:item.date,start:item.start}),{
       vapidDetails:{subject:c.app_origin,publicKey:c.public_key,privateKey:c.private_key},TTL:Math.max(1,Math.min(300,Math.floor((item.start-Date.now())/1000))),urgency:'high',topic:item.key.slice(0,32),timeout:5000
      });ok=true;sent++;
     }catch(e){failed++;error=String(e.statusCode||'send_failed');if([404,410].includes(e.statusCode))await P.service('push_subscriptions?id=eq.'+sub.id,{method:'PATCH',body:JSON.stringify({enabled:false})});}
     await P.rpc('push_finish_delivery',{p_id:sub.id,p_key:item.key,p_lease:lease,p_sent:ok,p_error:error});
    }
   }
   if(subs.length<100)break;after=subs[subs.length-1].id;
  }
  context.res=P.response(200,{sent,failed,more});
 }catch(e){context.res=P.response(e.status||503,{error:e.status?e.message:'Reminder worker could not complete this cycle.'});}
});
