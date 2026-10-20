// Push only: never caches family pages, API responses, PINs or authentication data.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
function bindingStore(mode,action){return new Promise((resolve,reject)=>{
 const open=indexedDB.open('trackline-push',1);open.onupgradeneeded=()=>open.result.createObjectStore('settings');open.onerror=()=>reject(open.error);
 open.onsuccess=()=>{const db=open.result,tx=db.transaction('settings',mode),store=tx.objectStore('settings');let request;
  try{request=action(store);}catch(e){db.close();reject(e);return;}
  tx.oncomplete=()=>{const result=request?.result;db.close();resolve(result);};tx.onerror=()=>{db.close();reject(tx.error);};
 };
});}
self.addEventListener('message',event=>{
 if(event.data?.type==='push-binding')event.waitUntil(bindingStore('readwrite',store=>store.put(event.data.id?{id:event.data.id,key:event.data.key}:null,'binding')).then(()=>event.ports?.[0]?.postMessage({ok:true})));
});
self.addEventListener('push',event=>event.waitUntil((async()=>{
 let data;try{data=event.data?.json();}catch{data=null;}
 if(!data||typeof data.body!=='string')return;
 const binding=await bindingStore('readonly',store=>store.get('binding'));
 // Dropped after sign-out/member switch, even if an old message was already in flight.
 if(!binding||binding.id!==data.binding||Date.now()>=data.expiresAt)return;
 let valid=false;
 try{const result=await fetch('/api/push-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'verify',id:binding.id,deviceKey:binding.key,key:data.key,kind:data.kind,itemId:data.itemId,start:data.start})});valid=result.ok&&(await result.json()).valid;}catch{}
 if(!valid)return;
 // The member may have signed out while the server checked this reminder.
 const latest=await bindingStore('readonly',store=>store.get('binding'));if(latest?.id!==binding.id)return;
 await self.registration.showNotification(String(data.title||'Trackline'),{body:data.body,tag:data.tag,icon:'/push-icon-192.png',badge:'/push-icon-192.png',data:{url:'/',binding},actions:[{action:'open',title:'Open Trackline'},{action:'dismiss',title:'Dismiss'}]});
})()));
self.addEventListener('notificationclick',event=>{
 event.notification.close();if(event.action==='dismiss')return;
 event.waitUntil((async()=>{const binding=await bindingStore('readonly',s=>s.get('binding'));if(binding?.id!==event.notification.data?.binding)return;
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});const own=clients.find(c=>new URL(c.url).origin===self.location.origin&&!new URL(c.url).pathname.startsWith('/admin'));
  if(own)return own.focus();return self.clients.openWindow('/');
 })());
});
