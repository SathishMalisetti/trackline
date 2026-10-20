const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='server-test';process.env.SUPABASE_PUBLISHABLE_KEY='publishable-test';
let responses=[],calls=[];
require.cache[require.resolve('node-fetch')]={exports:async(...args)=>{calls.push(args);const r=responses.shift();if(!r)throw Error('Unexpected request');return{ok:(r.status||200)<400,status:r.status||200,json:async()=>r.body,text:async()=>JSON.stringify(r.body)};}};
const {usageCategory}=require('../shared/usage-category'),ingest=require('../device-usage-ingest'),detail=require('../device-usage-detail');
const log=()=>{};log.error=()=>{};
const auth=()=>[{body:{id:'user',email:'kid@example.test'}},{body:[{family_id:'F1',member_id:'kid1',role:'kid'}]}];
async function run(handler,req,rows){calls=[];responses=rows;const c={log};await handler(c,req);return c.res;}
test('Minecraft is Games without labelling unrelated Java apps or overriding custom categories',()=>{
 for(const name of ['javaw.exe','JAVA.EXE','C:\\Java\\javaw.exe'])assert.equal(usageCategory(name,'Minecraft 26.3 - Singleplayer','Uncategorized'),'Games');
 assert.equal(usageCategory('Minecraft.Windows.exe','',null),'Games');
 assert.equal(usageCategory('javaw.exe','Java coding tool','Uncategorized'),'Uncategorized');
 assert.equal(usageCategory('javaw.exe','A document about Minecraft','Uncategorized'),'Uncategorized');
 assert.equal(usageCategory('chrome.exe','Minecraft guide','Uncategorized'),'Uncategorized');
 assert.equal(usageCategory('javaw.exe','Minecraft Education','Study'),'Study');
});
test('older installed agents receive Minecraft category correction at ingest, preserving device scope and title',async()=>{
 const token='device-secret';const res=await run(ingest,{method:'POST',body:{deviceId:'device1',deviceToken:token,date:'2026-10-20',hours:{'10':{apps:[{app:'javaw.exe',title:'Minecraft 26.3 - Singleplayer',category:'Uncategorized',active_seconds:600},{app:'javaw.exe',title:'Java coding tool',category:'Uncategorized',active_seconds:120}]}}}},[{body:[{id:'device1',family_id:'F1',member_id:'kid1',hostname:'laptop',device_token_hash:crypto.createHash('sha256').update(token).digest('hex'),revoked:false}]},{body:null},{body:null},{body:null}]);
 assert.equal(res.status,200);const saved=JSON.parse(calls[1][1].body);assert.deepEqual(saved.map(r=>r.category),['Games','Uncategorized']);assert.equal(saved[0].title,'Minecraft 26.3 - Singleplayer');assert.equal(saved[0].active_seconds,600);assert.ok(saved.every(r=>r.family_id==='F1'&&r.member_id==='kid1'&&r.device_id==='device1'));
});
test('report retains titles, aggregates repeated hours, separates categories and keeps precise totals',async()=>{
 const rows=[{source:'app',name:'javaw.exe',title:'Minecraft 26.3 - Singleplayer',category:'Uncategorized',active_seconds:600},{source:'app',name:'javaw.exe',title:'Minecraft 26.3 - Singleplayer',category:'Uncategorized',active_seconds:120},{source:'app',name:'javaw.exe',title:'Java coding tool',category:'Study',active_seconds:60},{source:'app',name:'chrome.exe',title:'YouTube - Google Chrome',category:'Uncategorized',active_seconds:20},{source:'app',name:'chrome.exe',title:'Different tab',category:'Uncategorized',active_seconds:20},{source:'site',name:'youtube.com',active_seconds:20}];
 const req={method:'GET',headers:{authorization:'Bearer test'},query:{familyId:'F1',memberId:'kid1',date:'2026-10-20'}};
 const res=await run(detail,req,[...auth(),{body:rows}]);assert.equal(res.status,200);const d=JSON.parse(res.body);assert.ok(calls[2][0].includes('select=source,name,title,'));assert.equal(d.apps[0].title,rows[0].title);assert.equal(d.apps[0].minutesUsed,12);assert.equal(d.apps[0].category,'Games');assert.equal(d.totalMinutes,14);assert.deepEqual(d.categoryTotals,{Games:12,Study:1,Uncategorized:1});
 const denied=await run(detail,{...req,query:{...req.query,memberId:'kid2'}},auth());assert.equal(denied.status,403);assert.equal(calls.length,2);
});
test('report renders name (title), wraps long titles and escapes HTML from ActivityWatch',()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const html=fs.readFileSync(path.join(__dirname,'../../app/index.html'),'utf8');
 const fn=html.slice(html.indexOf('function renderDayDrillModal(){'),html.indexOf('function renderDeviceManagerModal(){'));
 const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context={ui:{dayDrillOpen:true,dayDrillMemberName:'Kid',dayDrillMemberColor:'#C1555F',dayDrillData:{date:'2026-10-20',apps:[{name:'javaw.exe',title:'Minecraft <img src=x onerror=alert(1)>',category:'Games',minutesUsed:37}]}},escapeHtml,initials:()=> 'K',formatDateNice:()=> 'Oct 20',formatMinutesAsHM:n=>n+'m'};
 vm.createContext(context);vm.runInContext(fn,context);const rendered=context.renderDayDrillModal();assert.match(rendered,/javaw\.exe/);assert.ok(rendered.includes('(Minecraft &lt;img'));assert.ok(!rendered.includes('<img'));assert.ok(rendered.includes('overflow-wrap:anywhere'));
});
