// Exercise the actual UI against isolated mock family-session APIs.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..', 'app');
const profiles = [{ id: 'p1', name: 'QA Parent', role: 'parent', color: '#4C8577' }, { id: 'k1', name: 'QA Child', role: 'kid', color: '#CE8A2E' }];
const sessions = new Map(), pins = new Map(); let registered = false, emailCalls = 0;
const familyData = { family: { id: 'FAMILYQA', name: 'QA Family' }, members: profiles, events: [], chores: [], choreLogs: [], shoppingList: [], shoppingTrips: [], topicProgress: [], choreLibrary: [], activityLibrary: [], shoppingItemLibrary: [] };
const cookie = token => `__Host-trackline-family=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? 3600 : 0}`;
const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/api/')) {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode=404; return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html'); return res.end(fs.readFileSync(file));
  }
  res.setHeader('Content-Type','application/json');
  const reply = (status, data) => { res.statusCode=status; res.end(JSON.stringify(data)); };
  let raw=''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const token = /__Host-trackline-family=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  let session = sessions.get(token);
  if (req.url === '/api/auth-config') { emailCalls++; return reply(200,{}); }
  if (req.url === '/api/family-session') {
    if (req.method === 'DELETE') { sessions.delete(token); res.setHeader('Set-Cookie',cookie('')); return reply(200,{ok:true}); }
    if (req.method === 'POST' && body.action === 'setup' && session?.bootstrap) { session.setupCompleted=true; return reply(200,{ok:true}); }
    if (req.method === 'POST' && ['register','login'].includes(body.action)) {
      if (body.action === 'login' && (!registered || !['qa_user','FAMILYQA'].includes(body.identity) || body.password !== 'family-password')) return reply(403,{error:'Incorrect family ID, username or password.'});
      registered = true; const next=`${sessions.size+1}`.padStart(64,'a');
      session = { memberId:null, bootstrap:body.action==='register' }; sessions.set(next,session); res.setHeader('Set-Cookie',cookie(next));
      return reply(200,{familyId:'FAMILYQA',memberId:body.action==='register'?'p1':null});
    }
    if (!session) return reply(200,{signedIn:false});
    if (body.action === 'lock') session.memberId=null;
    return reply(200,{signedIn:true,familyId:'FAMILYQA',familyName:'QA Family',needsSetup:session.bootstrap&&!session.setupCompleted,members:profiles.map(p=>({...p,hasPin:pins.has(p.id),canSetPin:p.role==='kid'||session.bootstrap}))});
  }
  if (!session || req.headers['x-trackline-session'] !== 'family') return reply(401,{error:'Sign in.'});
  if (req.url === '/api/profile-pin') {
    const profile=profiles.find(p=>p.id===body.memberId);
    if (!profile || body.familyId!=='FAMILYQA') return reply(403,{error:'Different family.'});
    if (pins.has(profile.id) && pins.get(profile.id)!==body.pin) return reply(403,{error:'Incorrect PIN.'});
        pins.set(profile.id,body.pin); session.memberId=profile.id; session.bootstrap=false; return reply(200,{ok:true});
  }
  if (req.url === '/api/auth-me') {
    const member=profiles.find(p=>p.id===session.memberId);
    return reply(200,{email:null,memberships:member?[{family_id:'FAMILYQA',member_id:member.id,role:member.role}]:[]});
  }
  if (!session.memberId) return reply(403,{error:'PIN required.'});
  if (req.url.startsWith('/api/family-data')) return reply(200,familyData);
  if (req.url.startsWith('/api/study-assignments')) return reply(200,{days:[],overdue:[]});
  return reply(200,{usage:[],devices:[],categoryUsage:[],subjects:[],topics:[]});
});
(async () => {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined});
  try {
    const context=await browser.newContext(); await context.route('https://fonts.**/**',route=>route.abort());
    const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button',{name:'Create family',exact:true}).click();
    await page.locator('#family-entry-form').waitFor();
    assert.equal(await page.locator('input[type="email"]').count(),0);
    await page.locator('#entry-username').fill('qa_user');
    await page.locator('#entry-family-name').fill('QA Family');
    await page.locator('#entry-password').fill('family-password');
    await page.getByRole('button',{name:'Create family',exact:true}).click();
    await page.locator('#initial-family-setup').waitFor();
    await page.locator('#setup-parent-name').fill('QA Parent');
    await page.getByRole('button',{name:'Continue to PIN setup',exact:true}).click();
    await page.getByRole('heading',{name:'Set up your PIN',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Parent View',exact:true}).count(),0);
    await page.locator('#profile-pin').fill('1234');await page.locator('#profile-pin-confirm').fill('1234');
    await page.getByRole('button',{name:'Save PIN & continue',exact:true}).click();
    await page.getByRole('button',{name:'Parent View',exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>document.cookie), '');
    await page.reload();await page.getByRole('heading',{name:'Enter your PIN',exact:true}).waitFor();
    assert.equal(await page.locator('#family-entry-form').count(),0);assert.equal(await page.locator('#account-form').count(),0);
    await page.locator('#profile-pin').fill('9999');await page.getByRole('button',{name:'Unlock',exact:true}).click();
    await page.getByText('Incorrect PIN.',{exact:true}).waitFor();
    await page.locator('#profile-pin').fill('1234');await page.getByRole('button',{name:'Unlock',exact:true}).click();
    await page.getByRole('button',{name:'Parent View',exact:true}).waitFor();
    await page.evaluate(()=>logout());await page.locator('#profile-pin-form').waitFor();
    assert.equal(await page.getByRole('button',{name:'Parent View',exact:true}).count(),0);
    await page.locator('#family-member-choice').selectOption('k1');
    await page.getByRole('heading',{name:'Set up your PIN',exact:true}).waitFor();
    await page.locator('#profile-pin').fill('5678');await page.locator('#profile-pin-confirm').fill('5678');
    await page.getByRole('button',{name:'Save PIN & continue',exact:true}).click();
    await page.getByRole('button',{name:'Sign out of account',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Parent View',exact:true}).count(),0);
    await page.getByRole('button',{name:'Sign out of account',exact:true}).click();
    await page.getByRole('button',{name:'Join family',exact:true}).click();
    await page.locator('#family-entry-form').waitFor();
    await page.locator('#entry-identity').fill('FAMILYQA');await page.locator('#entry-password').fill('wrong');
    await page.getByRole('button',{name:'Join family',exact:true}).click();
    await page.getByText('Incorrect family ID, username or password.',{exact:true}).waitFor();
    await page.locator('#entry-password').fill('family-password');await page.getByRole('button',{name:'Join family',exact:true}).click();
    await page.getByRole('heading',{name:'Enter your PIN',exact:true}).waitFor();
    assert.equal(emailCalls,0); assert.deepEqual(errors,[]);
    await context.close();console.log('Family browser checks passed: username registration without email, PIN setup, remembered session, wrong PIN, lock, child role, logout, and family-ID/password login.');
  } finally { await browser.close(); server.close(); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
