// Visual rendering only: mock GET responses; any POST/write is rejected.
const {chromium}=require('playwright');const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const executable=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;const browser=await chromium.launch({headless:true,executablePath:executable||undefined});try{
 const html=fs.readFileSync('app/admin/index.html','utf8'),config=JSON.parse(fs.readFileSync('app/staticwebapp.config.json','utf8')),headers=config.routes.find(r=>r.route==='/admin').headers;fs.mkdirSync('/tmp/trackline-admin-layout',{recursive:true});
 const normalized=config.routes.map(r=>r.route.replace(/\/+$/,'')||'/');assert.equal(new Set(normalized).size,normalized.length,'Duplicate normalized Azure routes');
 const importId='11111111-1111-4111-8111-111111111111',unitId='22222222-2222-4222-8222-222222222222';
 const source={id:importId,subject:'Mathematics',year_levels:[4,7],status:'completed',attempts:1,source_url:'https://f10.vcaa.vic.edu.au/learning-areas/mathematics/curriculum',source_sha256:'a'.repeat(64),source_fetched_at:'2026-10-14T00:00:00Z',source_bytes:2000000,parser_version:'fixture',source_build_id:'fixture',attribution:'Fictional source fixture for rendering checks.',licence_url:'https://f10.vcaa.vic.edu.au/copyright-statement',summary:{created:2,revised:0,unchanged:0},created_at:'2026-10-14T00:00:00Z'};
 const unit={id:unitId,title:'Example reference',subject:'Mathematics',year_level:4,descriptor_code:'VC2M4N99',descriptor_text:'Fictional descriptor used only for layout verification.',curriculum_version:'Victorian Curriculum F-10 Version 2.0',source_url:source.source_url,source_import_id:importId,source_record_hash:'b'.repeat(64),source_current:true,source_details:{level_label:'Level 4',strand:'Number',elaborations:[{text:'Fictional worked context.'}],achievement_standard:'Fictional achievement standard.',attribution:source.attribution,licence_url:source.licence_url}};
 for(const [label,width,scheme,signedIn] of [['desktop',1440,'light',true],['mobile',390,'light',true],['dark',1200,'dark',true],['login',390,'light',false],['api404',390,'light',false]]){
  const context=await browser.newContext({viewport:{width,height:1000},colorScheme:scheme});const page=await context.newPage();let writes=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const r=route.request();if(r.method()!=='GET'){writes++;return route.abort();}
   if(r.url().endsWith('/admin'))return route.fulfill({contentType:'text/html',headers,body:html});
   if(r.url().endsWith('/api/platform-session'))return label==='api404'?route.fulfill({status:404,body:''}):route.fulfill({json:{signedIn,unlocked:signedIn,admin:signedIn?{id:'test-owner',username:'owner'}:null}});
   if(r.url().includes('/api/platform-manage'))return route.fulfill({json:r.url().includes('kind=overview')?{units:[],versions:[],jobs:[],generationConfigured:false,workerConfigured:false}:r.url().includes('kind=source-imports')?[source]:r.url().includes('kind=import-items')?[{change_type:'created',unit}]:r.url().includes('kind=units')?[unit]:[]});
   return route.abort();});
  await page.goto('https://admin-layout.test/admin');await page.waitForSelector(signedIn?'h1':'#gate-form');
  if(label==='api404')assert.match(await page.locator('#gate-status').innerText(),/API is unavailable \(HTTP 404\)/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' overflow');assert.equal(writes,0);assert.deepEqual(errors,[]);
  await page.screenshot({path:'/tmp/trackline-admin-layout/'+label+'.png',fullPage:true});
  if(signedIn)for(const [key,title] of [['curriculum','Curriculum library'],['sources','VCAA source imports'],['jobs','Generation jobs'],['families','Family support'],['admins','Administrators'],['audit','Audit history'],['settings','My account']]){
   await page.locator('nav [data-page="'+key+'"]').click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+'/'+key+' overflow');
   assert.equal(writes,0);assert.deepEqual(errors,[]);await page.screenshot({path:'/tmp/trackline-admin-layout/'+label+'-'+key+'.png',fullPage:true});
   if(key==='sources'){
    await page.getByRole('button',{name:'View references',exact:true}).click();await page.getByRole('heading',{name:'Imported references',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+'/import-items overflow');
    await page.getByRole('button',{name:'Open reference',exact:true}).click();await page.getByRole('heading',{name:'VC2M4N99 · Curriculum reference',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+'/reference overflow');assert.equal(writes,0);assert.deepEqual(errors,[]);
    await page.screenshot({path:'/tmp/trackline-admin-layout/'+label+'-reference.png',fullPage:true});
   }
  }
  await context.close();
 }
 console.log('PASS: desktop/mobile/dark admin screens and login rendering with CSP, no horizontal overflow, no script errors, no writes or login flows.');
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
