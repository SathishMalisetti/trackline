// Visual rendering only: mock GET responses; any POST/write is rejected.
const {chromium}=require('playwright');const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;const browser=await chromium.launch({headless:true,executablePath:executable||undefined});try{
 const html=fs.readFileSync('app/admin/index.html','utf8'),config=JSON.parse(fs.readFileSync('app/staticwebapp.config.json','utf8')),headers=config.routes.find(r=>r.route==='/admin').headers;fs.mkdirSync('/tmp/trackline-admin-layout',{recursive:true});
 const normalized=config.routes.map(r=>r.route.replace(/\/+$/,'')||'/');assert.equal(new Set(normalized).size,normalized.length,'Duplicate normalized Azure routes');
 for(const [label,width,scheme,signedIn] of [['desktop',1440,'light',true],['mobile',390,'light',true],['dark',1200,'dark',true],['login',390,'light',false],['api404',390,'light',false]]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:scheme});const page=await context.newPage();let writes=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const r=route.request();if(r.method()!=='GET'){writes++;return route.abort();}
   if(r.url().endsWith('/admin'))return route.fulfill({contentType:'text/html',headers,body:html});
   if(r.url().endsWith('/api/platform-session'))return label==='api404'?route.fulfill({status:404,body:''}):route.fulfill({json:{signedIn,unlocked:signedIn,admin:signedIn?{id:'test-owner',username:'owner'}:null}});
   if(r.url().includes('/api/platform-manage'))return route.fulfill({json:r.url().includes('kind=overview')?{units:[],versions:[],jobs:[],generationConfigured:false,workerConfigured:false}:[]});
   return route.abort();});
  await page.goto('https://admin-layout.test/admin');await page.waitForSelector(signedIn?'h1':'#gate-form');
  if(label==='api404')assert.match(await page.locator('#gate-status').innerText(),/API is unavailable \(HTTP 404\)/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' overflow');assert.equal(writes,0);assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/trackline-admin-layout/'+label+'.png',fullPage:true});
  if(signedIn)for(const [key,title] of [['curriculum','Curriculum library'],['jobs','Generation jobs'],['families','Family support'],['admins','Administrators'],['audit','Audit history'],['settings','My account']]){
   await page.locator('nav [data-page="'+key+'"]').click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+'/'+key+' overflow');
   assert.equal(writes,0);assert.deepEqual(errors,[]);await page.screenshot({path:'/tmp/trackline-admin-layout/'+label+'-'+key+'.png',fullPage:true});
  }
  await context.close();
 }
 console.log('PASS: desktop/mobile/dark admin screens and login rendering with CSP, no horizontal overflow, no script errors, no writes or login flows.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
