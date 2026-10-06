const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'public-test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only';
let responses, calls;
require.cache[require.resolve('node-fetch')] = { exports: async (...args) => {
  calls.push(args); const response = responses.shift(); if (!response) throw Error('Unexpected call');
  return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
}};
const familyEntry = require('../family-session');
const { protect } = require('../shared/auth');
const { digest } = require('../shared/family-session');
const { legacyHash, hashSecret } = require('../shared/credentials');
const token = 'a'.repeat(64);
const family = { id: 'FAMILY1', name: 'Test Family', password_hash: 'password-version' };
const device = { token_hash: digest(token), family_id: 'FAMILY1', member_id: null, password_version: 'password-version', bootstrap_member_id: null };
const request = () => ({ method: 'GET', headers: { cookie: `__Host-trackline-family=${token}`, 'x-trackline-session': 'family', host: 'app.example', origin: 'https://app.example' }, query: { familyId: 'FAMILY1' } });
async function runEntry(req, data = []) {
  calls = []; responses = data.map(body => ({ status: 200, body })); const context = {};
  await familyEntry(context, req); return context.res;
}
async function runProtected(req, options, extra = []) {
  calls = []; responses = [[device],[family],...extra].map(body => ({ status: 200, body }));
  const context = {}; let reached = false;
  await protect(async ctx => { reached = true; ctx.res = { status: 200, body: '{}' }; }, options)(context, req);
  return { context, reached };
}
test('signed-out family status exposes no application data', async () => {
  const response = await runEntry({ ...request(), headers: {} });
  assert.deepEqual(JSON.parse(response.body), { signedIn: false }); assert.equal(calls.length, 0);
});
test('cross-origin registration is rejected before any database write', async () => {
  const response = await runEntry({ ...request(), method: 'POST', headers: { host: 'app.example', origin: 'https://attacker.example' }, body: { action: 'register' } });
  assert.equal(response.status, 403); assert.equal(calls.length, 0);
});
test('username registration needs no email and stores only a hashed session token', async () => {
  const response = await runEntry({ ...request(), method: 'POST', body: { action: 'register', username: 'New_User', familyName: 'Family', parentName: 'Parent', password: 'family-password', role: 'admin', familyId: 'VICTIM' } }, [{ status: 200, familyId: 'NEW', memberId: 'parent-1' }]);
  assert.equal(response.status, 200);
  assert.match(response.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/);
  const raw = response.headers['Set-Cookie'].split(';')[0].split('=')[1];
  const payload = JSON.parse(calls[0][1].body);
  assert.equal(payload.p_username, 'new_user'); assert.equal(payload.p_token_hash, digest(raw));
  assert.match(payload.p_password_hash, /^scrypt:/); assert.equal(payload.p_legacy_hash, legacyHash('family-password'));
  assert.ok(!('p_email' in payload)); assert.ok(!('role' in payload)); assert.ok(!response.body.includes(raw));
});
test('wrong family password cannot create a session or trust submitted roles', async () => {
  const response = await runEntry({ ...request(), method: 'POST', body: { action: 'login', identity: 'FAMILY1', password: 'wrong', role: 'parent' } }, [[{ ...family, password_hash: legacyHash('correct-password') }], { status: 403, error: 'Incorrect credentials.' }]);
  assert.equal(response.status, 403); assert.ok(!response.headers['Set-Cookie']);
  assert.equal(JSON.parse(calls[1][1].body).p_matches, false);
});
test('password login checks salted credentials without falling back to weak legacy hash', async () => {
  const secure = await hashSecret('correct-password');
  const response = await runEntry({ ...request(), method: 'POST', body: { action: 'login', identity: 'test_user', password: 'wrong' } }, [[{ ...family, login_password_hash: secure, login_password_version: family.password_hash }], { status: 403 }]);
  assert.equal(response.status, 403); assert.equal(JSON.parse(calls[1][1].body).p_matches, false);
});
test('family password alone cannot read family data before profile PIN unlock', async () => {
  const result = await runProtected(request(), {});
  assert.equal(result.context.res.status, 403); assert.equal(result.reached, false);
});
test('pending family session can reach only explicitly allowed PIN entry', async () => {
  const result = await runProtected(request(), { familyEntry: true });
  assert.equal(result.context.res.status, 200); assert.equal(result.reached, true);
  const other = { ...request(), query: { familyId: 'OTHER' } };
  assert.equal((await runProtected(other, { familyEntry: true })).context.res.status, 403);
});
test('member role is read from the database and child sessions cannot become parents', async () => {
  const saved = device.member_id; const version = device.pin_version;
  device.member_id = 'kid-1'; device.pin_version = 'kid-pin';
  try {
    const result = await runProtected({ ...request(), body: { role: 'parent' } }, { parent: true }, [[{ id: 'kid-1', role: 'kid', pin_hash: 'kid-pin' }]]);
    assert.equal(result.context.res.status, 403); assert.equal(result.reached, false);
    const changedPin = await runProtected(request(), {}, [[{ id: 'kid-1', role: 'kid', pin_hash: 'new-pin' }]]);
    assert.equal(changedPin.context.res.status, 403);
  } finally { device.member_id = saved; device.pin_version = version; }
});
test('session expiry cannot downgrade to a supplied email token', async () => {
  calls = []; responses = [{ status: 200, body: [] }]; const context = {};
  const req = request(); req.headers.authorization = 'Bearer valid-email-token';
  await protect(() => assert.fail('Must not reach handler'))(context, req);
  assert.equal(context.res.status, 401); assert.equal(calls.length, 1);
});
test('family password change invalidates existing device sessions', async () => {
  calls = []; responses = [{ status: 200, body: [device] }, { status: 200, body: [{ ...family, password_hash: 'changed' }] }]; const context = {};
  await protect(() => assert.fail('Must not reach handler'))(context, request());
  assert.equal(context.res.status, 401);
});
test('profile lists omit PIN hashes and locking clears server-side profile access', async () => {
  const response = await runEntry({ ...request(), method: 'POST', body: { action: 'lock' } }, [[device],[family],[],[{ id: 'p1', name: 'Parent', role: 'parent', pin_hash: 'private-pin' }]]);
  assert.equal(response.status, 200); assert.ok(!response.body.includes('private-pin'));
  assert.deepEqual(JSON.parse(calls[2][1].body), { member_id: null, pin_version: null });
  assert.equal(JSON.parse(response.body).members[0].canSetPin, true);
});
