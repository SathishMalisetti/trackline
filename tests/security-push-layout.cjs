// Notification UI only, fixture profiles and mocked read-only status. No login or real push delivery.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});try{
 const app=fs.readFileSync('app/index.html','utf8'),script=fs.readFileSync('app/push-notifications.js','utf8'),css=[...app.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join('\n');
 for(const [role,width,day] of [['parent',390,true],['parent',1440,false],['kid',390,true]]){
  const context=await browser.newContext({viewport:{width,height:1000},permissions:['notifications']});const page=await context.newPage(),errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{Object.defineProperty(Notification,'permission',{get:()=> 'granted'});Object.defineProperty(navigator.serviceWorker,'getRegistration',{value:async()=>({active:{postMessage:(message,ports)=>ports[0].postMessage({ok:true})},pushManager:{getSubscription:async()=>({})}})});});
  await page.route('**/*',async route=>{const r=route.request(),url=new URL(r.url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><style>${css}</style></head><body class="${day?'day-mode':''}"><main style="padding:16px;width:100%;max-width:700px;margin:auto"><div id="push-panel"></div><div id="item"></div></main><script>
    window.ui={authenticated:true};window.state={members:[{id:'parent',name:'Parent',role:'parent'},{id:'kid1',name:'First child with a long display name',role:'kid'},{id:'kid2',name:'Second child',role:'kid'}]};window.tracklineAuth={demo:false,membership:{family_id:'F1',member_id:'${role==='parent'?'parent':'kid1'}',role:'${role}'},fetch:fetch.bind(window),clear(){},lock(){},signOut(){}};window.showAlert=message=>{throw Error(message)};
    localStorage.setItem('trackline-push-device',JSON.stringify({id:'11111111-1111-4111-8111-111111111111',key:'a'.repeat(64),owner:'F1:${role==='parent'?'parent':'kid1'}'}));
   </script><script src="/push-notifications.js"></script></body></html>`});
   if(url.pathname==='/push-notifications.js')return route.fulfill({contentType:'application/javascript',body:script});
   if(url.pathname==='/api/push-settings'){const b=JSON.parse(r.postData());actions.push(b.action);assert.equal(b.action,'status');return route.fulfill({json:{subscription:{id:b.id,enabled:true,minutesBefore:15,childIds:role==='parent'?['kid1']:[],timezone:'Australia/Melbourne'},mutes:[]}});}
   return route.abort();
  });
  await page.goto('https://push-layout.test/');await page.getByRole('heading',{name:'Notifications on this device'}).waitFor();
  assert.equal(await page.locator('#push-minutes').inputValue(),'15');assert.equal(await page.locator('[name="push-child"]').count(),role==='parent'?2:0);
  if(role==='parent')assert.equal(await page.locator('[name="push-child"][value="kid1"]').isChecked(),true);
  await page.evaluate(()=>{document.getElementById('item').innerHTML=tracklinePush.itemControl('task','task1');});assert.equal(await page.locator('[data-push-kind="task"]').isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Notification panel horizontal overflow');assert.deepEqual(errors,[]);assert.deepEqual(actions,['status']);
  fs.mkdirSync('/tmp/trackline-push-layout',{recursive:true});await page.screenshot({path:`/tmp/trackline-push-layout/${role}-${width}.png`,fullPage:true});await context.close();
 }
 console.log('PASS: parent/child notification settings, selected children, per-item control and mobile/desktop themes; mock status reads only, no login, subscription writes or push sends.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
