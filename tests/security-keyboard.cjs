// Isolated keyboard regression: real app markup/handlers, fixture data only.
// Never starts the app, authenticates, saves tasks or connects to the database.
const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.TRACKLINE_KEYBOARD_SOURCE||'app/index.html','utf8');
const chore=source.slice(source.indexOf('function renderChoreModal(){'),source.indexOf('function renderCompleteChoreModal(){'));
const enhance=source.slice(source.indexOf('function enhancePresentation(root){'),source.indexOf('\nfunction render(){',source.indexOf('function enhancePresentation(root){')));
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});try{
 const page=await browser.newPage();let requests=0;await page.route('**/*',route=>{requests++;return route.abort();});
 await page.setContent('<style>.overlay{position:fixed;inset:0;padding:40px}.modal{width:500px;background:white}.field{margin:8px}#choreDaysFields{display:none}</style><div id="root"></div>');
 await page.evaluate(({chore,enhance})=>{
  window.ui={choreModalOpen:true};window.state={members:[{id:'kid1',name:'Kid1'}],chores:[],choreLibrary:[]};window.DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  window.isParentLoggedIn=()=>true;window.todayISO=()=> '2026-10-20';window.escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.closedCount=0;window.saved=0;window.custom=0;
  window.closeChoreModal=()=>{window.closedCount++;document.querySelector('.overlay')?.remove();};window.saveChore=()=>{window.saved++;};
  (0,eval)(chore+'\n'+enhance);
  window.mount=()=>{document.getElementById('root').innerHTML=renderChoreModal()+'<div id="custom" onclick="window.custom++"><input id="nested"><textarea id="nested-text"></textarea>Custom control</div>';enhancePresentation(document.getElementById('root'));};window.mount();
 },{chore,enhance});
 const title=page.locator('#f_chore_title');await title.focus();await title.pressSequentially('Swimming practice after school');
 assert.equal(await page.locator('.modal').count(),1,'Space must not dismiss Add task');assert.equal(await title.inputValue(),'Swimming practice after school');assert.equal(await page.evaluate(()=>window.closedCount),0);
 await title.press('Enter');assert.equal(await page.evaluate(()=>window.closedCount),0);
 assert.equal(await page.locator('.overlay').getAttribute('role'),null);assert.equal(await page.locator('.overlay').getAttribute('tabindex'),null);
 for(const id of ['nested','nested-text']){const input=page.locator('#'+id);await input.focus();await input.pressSequentially('two words');assert.equal(await input.inputValue(),'two words');await input.press('Enter');assert.equal(await page.evaluate(()=>window.custom),0,'Nested editing must not activate ancestor');}
 await page.locator('#custom').focus();await page.keyboard.press('Space');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.custom),2,'Focused custom controls remain keyboard accessible');
 const save=page.getByRole('button',{name:'Save',exact:true});await save.focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#f_chore_title').evaluate(el=>el===document.activeElement),true);await page.keyboard.press('Shift+Tab');assert.equal(await save.evaluate(el=>el===document.activeElement),true);
 await page.getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>window.closedCount),1,'Native Cancel still activates with Space');assert.equal(await page.evaluate(()=>window.saved),0);
 await page.evaluate(()=>window.mount());await page.locator('.overlay').click({position:{x:5,y:5}});assert.equal(await page.evaluate(()=>window.closedCount),2,'Backdrop pointer click still dismisses');
 assert.equal(requests,0);console.log('PASS: Add task spaces/Enter, nested input/textarea, custom-control keyboard access, focus trap, native Cancel and backdrop click; no login, API calls or database writes.');
 }finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
