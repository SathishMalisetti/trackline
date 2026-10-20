/* Background reminders. Existing family login and PIN APIs remain authoritative. */
(function(){
 const S={owner:null,loading:false,busy:false,subscription:null,mutes:[],error:'',generation:0};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const eligible=()=>typeof ui!=='undefined'&&ui.authenticated&&!tracklineAuth.demo&&tracklineAuth.membership?.member_id;
 const owner=()=>eligible()?tracklineAuth.membership.family_id+':'+tracklineAuth.membership.member_id:null;
 function local(){let value;try{value=JSON.parse(localStorage.getItem('trackline-push-device')||'null');}catch{}
  if(!value||!/^[a-f0-9]{64}$/.test(value.key||'')){value={key:Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('')};localStorage.setItem('trackline-push-device',JSON.stringify(value));}return value;}
 function store(value){localStorage.setItem('trackline-push-device',JSON.stringify(value));}
 function supported(){return isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;}
 function needsInstall(){return (/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1))&&!matchMedia('(display-mode: standalone)').matches&&!navigator.standalone;}
 async function request(action,body={}){
  const m=tracklineAuth.membership;if(!m)throw Error('Unlock a family profile first.');
  const d=local();const r=await tracklineAuth.fetch('/api/push-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,familyId:m.family_id,deviceKey:d.key,id:d.id||null,...body})});
  const result=await r.json();if(!r.ok)throw Error(result.error||'Could not update reminders.');return result;
 }
 async function worker(){const r=await navigator.serviceWorker.register('/push-sw.js',{scope:'/'});await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Notification service is taking too long. Please retry.')),8000))]);return r;}
 async function bind(reg,id){const active=reg.active;if(!active)throw Error('Notification service is starting. Please retry.');
  await new Promise((resolve,reject)=>{const c=new MessageChannel(),timer=setTimeout(()=>reject(Error('Could not update this device notification profile.')),3000);c.port1.onmessage=()=>{clearTimeout(timer);c.port1.close();resolve();};active.postMessage({type:'push-binding',id,key:id?local().key:null},[c.port2]);});}
 function deactivate(){if(S.deactivation)return S.deactivation;S.deactivation=doDeactivate().finally(()=>{S.deactivation=null;});return S.deactivation;}
 async function doDeactivate(){
  const d=local();S.subscription=null;S.mutes=[];
  const registration='serviceWorker'in navigator?await navigator.serviceWorker.getRegistration('/'):null;
  if(registration){try{await bind(registration,null);}catch{}const sub=await registration.pushManager.getSubscription();if(sub)await sub.unsubscribe();for(const n of await registration.getNotifications())n.close();}
  if(d.id){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);try{await fetch('/api/push-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({action:'revoke',id:d.id,deviceKey:d.key})});}finally{clearTimeout(timer);}}
 }
 async function syncProfile(){
  const key=owner();if(key===S.owner)return;S.owner=key;const generation=++S.generation;S.error='';S.subscription=null;S.mutes=[];
  if(!key){S.loading=false;return;}S.loading=true;
  try{const d=local();if(d.owner&&d.owner!==key)await deactivate();if(generation!==S.generation)return;
   const data=await request('status');if(generation!==S.generation)return;S.subscription=data.subscription;S.mutes=data.mutes||[];
   if(S.subscription?.enabled&&(typeof Notification==='undefined'||Notification.permission!=='granted')){await deactivate();}
   else if(S.subscription?.enabled){
    const registration=await navigator.serviceWorker.getRegistration('/');
    if(registration&&await registration.pushManager.getSubscription())await bind(registration,S.subscription.id);
    else {S.subscription.enabled=false;S.error='Reconnect notifications on this device using Enable notifications.';}
   }
  }catch(error){if(generation===S.generation)S.error=error.message;}finally{if(generation===S.generation){S.loading=false;refresh();}}
 }
 function panel(){
  if(tracklineAuth.demo)return '<section class="settings-card"><h3>Notifications</h3><p>Background notifications are available in your real family account.</p></section>';
  const sub=S.subscription,enabled=!!sub?.enabled,member=tracklineAuth.membership;
  const children=member?.role==='parent'?(state.members||[]).filter(m=>m.role==='kid'):[];
  const zone=sub?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone||'Australia/Melbourne';
  return `<section class="settings-card" id="push-panel"><h3>Notifications on this device</h3><p>Reminders arrive even when Trackline is closed. You always receive your own calendar events and timed tasks.</p>
   ${needsInstall()?'<p class="skip-note">On iPhone or iPad, use Share → Add to Home Screen, open Trackline from that icon, then enable notifications.</p>':''}
   <p role="status" aria-live="polite">${S.loading?'Loading notification settings…':enabled?'Enabled for this profile on this device':'Notifications are off on this device'}</p>
   ${S.error?`<p role="alert" style="color:var(--danger)">${esc(S.error)}</p>`:''}
   <form id="push-form"><div class="field"><label for="push-minutes">Remind me before</label><div style="display:flex;align-items:center;gap:8px"><input id="push-minutes" type="number" min="1" max="1440" step="1" value="${sub?.minutesBefore||15}" required style="width:100px;min-height:44px"> minutes</div></div>
   <div class="field"><label for="push-timezone">Schedule timezone</label><input id="push-timezone" value="${esc(zone)}" required maxlength="100"><small style="display:block;margin-top:6px">Use the timezone in which your family scheduled the activities.</small></div>
   ${children.length?`<fieldset style="border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px"><legend>Also remind me about</legend>${children.map(m=>`<label style="display:flex;align-items:center;gap:10px;min-height:44px"><input type="checkbox" name="push-child" value="${esc(m.id)}" ${(sub?.childIds||[]).includes(m.id)?'checked':''}>${esc(m.name)}</label>`).join('')}</fieldset>`:''}
   <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn primary" data-push-action="enable" ${S.busy||S.loading||needsInstall()||!supported()?'disabled':''}>${S.busy?'Saving…':enabled?'Save reminder settings':'Enable notifications'}</button>${enabled?'<button type="button" class="btn ghost" data-push-action="disable">Turn off on this device</button>':''}<button type="button" class="btn ghost" data-push-action="reload">Refresh status</button></div>
   ${!supported()&&!needsInstall()?'<p>This browser does not support background notifications. Try a current supported browser.</p>':''}
   <p style="font-size:13px;color:var(--text-dim)">Tasks need a due time. Completed, deleted or skipped items are not reminded. Delivery can be delayed when a device is offline or notifications are blocked.</p></form></section>`;
 }
 function itemControl(kind,id){
  if(!id||tracklineAuth.demo)return '';
  const muted=S.mutes.some(m=>m.kind===kind&&m.item_id===id),enabled=S.subscription?.enabled;
  return `<div class="field" data-push-item-container data-kind="${kind}" data-item="${esc(id)}"><label style="display:flex;align-items:center;gap:10px;min-height:44px"><input type="checkbox" data-push-kind="${kind}" data-push-item="${esc(id)}" ${!muted?'checked':''} ${!enabled||S.busy?'disabled':''}>Remind this device about this ${kind==='task'?'task':'activity'}</label><small>${enabled?'Saved immediately for this device. Uses your notification timing; recurring items apply to the whole series.':'Enable notifications in Settings to change this reminder.'}</small></div>`;
 }
 function refresh(){const p=document.getElementById('push-panel');if(p)p.outerHTML=panel();document.querySelectorAll('[data-push-item-container]').forEach(n=>{n.outerHTML=itemControl(n.dataset.kind,n.dataset.item);});}
 async function enable(){
  if(S.busy||!eligible())return;const form=document.getElementById('push-form');if(!form?.reportValidity())return;
  const settings={minutesBefore:Number(document.getElementById('push-minutes').value),timezone:document.getElementById('push-timezone').value.trim(),childIds:[...form.querySelectorAll('[name="push-child"]:checked')].map(n=>n.value)};
  S.busy=true;S.error='';const revision=S.generation;for(const button of form.querySelectorAll('button'))button.disabled=true;const saveButton=form.querySelector('[data-push-action="enable"]');if(saveButton)saveButton.textContent='Saving…';
  try{
   if(!supported()||needsInstall())throw Error('Install Trackline on your Home Screen or use a supported browser.');
   // Must be requested directly from this click, before asynchronous network calls (iOS).
   const permission=await Notification.requestPermission();if(S.deactivation)await S.deactivation;if(permission!=='granted')throw Error('Notifications were not allowed. You can enable them in browser or device settings.');
   const keyResult=await tracklineAuth.fetch('/api/push-settings?familyId='+encodeURIComponent(tracklineAuth.membership.family_id));const config=await keyResult.json();if(!keyResult.ok)throw Error(config.error||'Could not configure reminders.');
   if(config.appOrigin!==location.origin)throw Error('Enable notifications from the published Trackline website.');
   const registration=await worker();let subscription=await registration.pushManager.getSubscription();
   if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(config.publicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))});
   if(revision!==S.generation){await subscription.unsubscribe();return;}
   const result=await request('subscribe',{subscription:subscription.toJSON(),...settings});const d=local();d.id=result.id;d.owner=owner();store(d);
   if(revision!==S.generation){await deactivate();return;}await bind(registration,result.id);S.subscription={id:result.id,enabled:true,...settings};
   try{const legacy=JSON.parse(localStorage.getItem('trackline-notify-prefs')||'{}');legacy.enabled=false;localStorage.setItem('trackline-notify-prefs',JSON.stringify(legacy));}catch{}
  }catch(error){S.error=error.message;if(!S.subscription?.enabled)try{await deactivate();}catch{}}finally{S.busy=false;refresh();}
 }
 document.addEventListener('submit',event=>{if(event.target.id==='push-form'){event.preventDefault();enable();}});
 document.addEventListener('click',async event=>{const action=event.target.closest('[data-push-action]')?.dataset.pushAction;if(!action)return;event.preventDefault();
  if(action==='enable')return enable();if(action==='reload'){S.owner=null;return syncProfile();}
  if(action==='disable'){S.busy=true;try{await deactivate();S.error='';}catch{S.error='Notifications are unsubscribed locally. Server revocation will be retried when you sign out or enable again.';}finally{S.busy=false;refresh();}}
 });
 document.addEventListener('change',async event=>{const input=event.target;if(!input.matches('[data-push-kind]'))return;const prior=!input.checked;input.disabled=true;
  try{await request('item',{kind:input.dataset.pushKind,itemId:input.dataset.pushItem,enabled:input.checked});S.mutes=S.mutes.filter(m=>m.kind!==input.dataset.pushKind||m.item_id!==input.dataset.pushItem);if(!input.checked)S.mutes.push({kind:input.dataset.pushKind,item_id:input.dataset.pushItem});}
  catch(error){input.checked=prior;showAlert(error.message);}finally{refresh();}
 });
 // Deactivate before existing account transitions. Closing a page does not deactivate.
 for(const name of ['lock','signOut','confirmHome']){const original=tracklineAuth[name];if(typeof original==='function')tracklineAuth[name]=async function(...args){try{await deactivate();}catch{}return original.apply(this,args);};}
 const originalClear=tracklineAuth.clear;tracklineAuth.clear=function(...args){S.owner=null;S.generation++;S.subscription=null;S.mutes=[];deactivate().catch(()=>{});return originalClear.apply(this,args);};
 window.tracklinePush={panel,itemControl,syncProfile};syncProfile();
})();
