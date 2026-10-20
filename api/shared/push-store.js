const crypto=require('node:crypto');
const {service}=require('./family-session');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const response=(status,body)=>({status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify(body)});
const rpc=(name,body)=>service('rpc/'+name,{method:'POST',body:JSON.stringify(body)});
function deviceKey(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail('Invalid notification device.');return digest(value);}
function id(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw fail('Invalid notification subscription.');return value;}
function validSubscription(value){
 let url;try{url=new URL(value?.endpoint);}catch{throw fail('Invalid push subscription.');}
 const host=/^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)*notify\.windows\.com|web\.push\.apple\.com)$/i;
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!host.test(url.hostname)||url.href.length>2048)throw fail('Unsupported push service.');
 const {auth,p256dh}=value.keys||{};
 if(typeof auth!=='string'||!/^[A-Za-z0-9_-]{22}={0,2}$/.test(auth)||typeof p256dh!=='string'||!/^[A-Za-z0-9_-]{87}={0,2}$/.test(p256dh))throw fail('Invalid push encryption keys.');
 return{endpoint:url.href,keys:{auth,p256dh}};
}
async function config(initialise=false){
 let [row]=await service('push_config?id=eq.true&select=*');
 if(!row?.enabled)throw fail('Background reminders are not configured yet.',503);
 if(initialise&&!row.public_key){const keys=require('web-push').generateVAPIDKeys();await rpc('push_initialise_keys',{p_public:keys.publicKey,p_private:keys.privateKey});[row]=await service('push_config?id=eq.true&select=*');}
 return row;
}
function protectWorker(handler){return async(context,req)=>{
 try{
  if(req.method!=='POST')throw fail('Method not allowed.',405);
  const headers=req.headers||{},minute=headers['x-trackline-push-minute'],nonce=headers['x-trackline-push-nonce'],proof=headers['x-trackline-push-proof'];
  if(!/^\d{7,12}$/.test(minute||'')||!/^[a-f0-9-]{36}$/.test(nonce||'')||!/^[a-f0-9]{64}$/.test(proof||'')||Math.abs(Math.floor(Date.now()/60000)-Number(minute))>1)throw fail('Worker authorization required.',401);
  const c=await config(),expected=crypto.createHmac('sha256',c.worker_secret).update(minute+':'+nonce).digest('hex');
  if(!crypto.timingSafeEqual(Buffer.from(proof),Buffer.from(expected)))throw fail('Worker authorization required.',401);
  req.pushConfig=c;await handler(context,req);
 }catch(e){context.res=response(e.status||503,{error:e.status?e.message:'Reminder worker could not complete this cycle.'});}
};}
module.exports={service,fail,digest,response,rpc,deviceKey,id,validSubscription,config,protectWorker};
