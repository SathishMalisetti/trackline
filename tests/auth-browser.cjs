// Mocked browser integration checks; no real project or family data is used.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..', 'app');
const family = {
  family: { id: 'FAMILY1', name: 'Test Family' },
  members: [{ id: 'parent-1', name: 'Test Parent', role: 'parent', color: '#4C8577' }, { id: 'kid-1', name: 'Test Child', role: 'kid', color: '#CE8A2E' }],
  events: [], chores: [], choreLogs: [], shoppingList: [], shoppingTrips: [], topicProgress: [], choreLibrary: [], activityLibrary: [], shoppingItemLibrary: [],
};
const apiCalls = [];
let newFamilyCreated = false;
const accountPins = new Map();
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    apiCalls.push({ url: req.url, authorization: req.headers['x-trackline-authorization'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth-config') return res.end(JSON.stringify({ url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test' }));
    if (!req.headers['x-trackline-authorization']) { res.statusCode = 401; return res.end('{}'); }
    if (req.url.startsWith('/api/profile-pin')) {
      const token = req.headers['x-trackline-authorization'];
      if (req.method === 'GET') return res.end(JSON.stringify({ hasPin: accountPins.has(token) }));
      let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
        const pin = JSON.parse(body).pin;
        if (accountPins.has(token) && accountPins.get(token) !== pin) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Incorrect PIN.' })); }
        accountPins.set(token, pin); res.end(JSON.stringify({ ok: true }));
      }); return;
    }
    if (req.url === '/api/create-family') { newFamilyCreated = true; return res.end(JSON.stringify({ family_id: 'FAMILY1' })); }
    if (req.url === '/api/auth-me') {
      if (req.headers['x-trackline-authorization'].includes('newtoken') && !newFamilyCreated) return res.end(JSON.stringify({ email: 'new@example.com', memberships: [] }));
      const isKid = req.headers['x-trackline-authorization'].includes('kidtoken');
      return res.end(JSON.stringify({ email: isKid ? 'kid@example.com' : 'parent@example.com', memberships: [{ family_id: 'FAMILY1', member_id: isKid ? 'kid-1' : 'parent-1', role: isKid ? 'kid' : 'parent' }] }));
    }
    if (req.url.startsWith('/api/family-data')) return res.end(JSON.stringify(family));
    if (req.url.startsWith('/api/study-assignments')) return res.end(JSON.stringify({ days: [], overdue: [] }));
    return res.end(JSON.stringify({ usage: [], devices: [], categoryUsage: [], subjects: [], topics: [] }));
  }
  const filename = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!filename.startsWith(root) || !fs.existsSync(filename)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', filename.endsWith('.js') ? 'application/javascript' : 'text/html');
  res.end(fs.readFileSync(filename));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext();
    await context.route('https://fonts.googleapis.com/**', route => route.abort());
    await context.route('https://fonts.gstatic.com/**', route => route.abort());
    await context.route('https://test.supabase.co/**', async route => {
      const url = route.request().url();
      const body = route.request().postDataJSON() || {};
      if (url.includes('/signup')) return route.fulfill({ json: { user: { id: 'u1', email: body.email }, session: null } });
      if (url.includes('/token')) return route.fulfill({ json: {
        access_token: body.email.startsWith('kid') ? 'kidtoken' : body.email.startsWith('new') ? 'newtoken' : 'parenttoken', refresh_token: 'refresh',
        token_type: 'bearer', expires_in: 3600, user: { id: 'u1', email: body.email, email_confirmed_at: '2026-01-01' },
      } });
      if (url.includes('/logout')) return route.fulfill({ status: 204 });
      return route.fulfill({ json: {} });
    });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    async function setupPin() {
      await page.locator('#profile-pin-form').waitFor();
      await page.locator('#profile-pin').fill('1234');
      await page.locator('#profile-pin-confirm').fill('1234');
      await page.getByRole('button', { name: 'Save PIN & continue', exact: true }).click();
    }
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    await page.locator('#account-form').waitFor();
    assert.equal(await page.getByText('Test Family', { exact: true }).count(), 0);
    assert.equal(apiCalls.filter(c => !c.authorization && c.url !== '/api/auth-config').length, 0);
    await page.locator('#account-toggle').click();
    await page.locator('#account-email').fill('new@example.com');
    await page.locator('#account-password').fill('test-password');
    await page.locator('#account-form button').click();
    await page.getByText('Check your email to confirm your account, then sign in.').waitFor();
    await page.locator('#account-toggle').click();
    await page.locator('#account-email').fill('parent@example.com');
    await page.locator('#account-password').fill('test-password');
    await page.locator('#account-form button').click();
    await setupPin();
    await page.getByRole('button', { name: 'Parent View', exact: true }).waitFor();
    assert.ok(apiCalls.find(c => c.url.startsWith('/api/family-data') && c.authorization === 'Bearer parenttoken'));
    await page.reload();
    await page.getByRole('heading', { name: 'Enter your PIN', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Parent View', exact: true }).count(), 0);
    assert.equal(await page.locator('#account-form').count(), 0);
    await page.locator('#profile-pin').fill('9999');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByText('Incorrect PIN.', { exact: true }).waitFor();
    await page.locator('#profile-pin').fill('1234');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByRole('button', { name: 'Parent View', exact: true }).waitFor();
    await page.evaluate(() => { ui.dayDrillData = { privateParentData: true }; ui.deviceManagerDevices = [{ privateParentData: true }]; });
    await page.getByRole('button', { name: 'Sign out of account' }).click();
    await page.locator('#account-form').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('trackline-data')), null);
    await page.locator('#account-email').fill('kid@example.com');
    await page.locator('#account-password').fill('test-password');
    await page.locator('#account-form button').click();
    await setupPin();
    await page.getByRole('button', { name: 'Sign out of account' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Parent View', exact: true }).count(), 0);
    await page.evaluate(() => openLogin('parent-1'));
    assert.equal(await page.locator('#pin_input').count(), 0);
    assert.equal(await page.evaluate(() => ui.dayDrillData), null);
    assert.equal(await page.evaluate(() => ui.deviceManagerDevices), null);
    await page.getByRole('button', { name: 'Sign out of account' }).click();
    await page.locator('#account-form').waitFor();
    await page.locator('#account-email').fill('new@example.com');
    await page.locator('#account-password').fill('test-password');
    await page.locator('#account-form button').click();
    await page.getByRole('heading', { name: 'Set up your family' }).waitFor();
    await page.locator('#family-name').fill('New Family');
    await page.locator('#parent-name').fill('New Parent');
    await page.getByRole('button', { name: 'Create family', exact: true }).click();
    await setupPin();
    await page.getByRole('button', { name: 'Parent View', exact: true }).waitFor();
    assert.ok(apiCalls.find(c => c.url === '/api/create-family' && c.authorization === 'Bearer newtoken'));
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: signed-out gate, confirmation, parent login, bearer requests, logout cleanup, child restrictions.');
    await context.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
