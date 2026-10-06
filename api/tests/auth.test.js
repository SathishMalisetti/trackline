const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'server-only';
let responses, calls;
require.cache[require.resolve('node-fetch')] = { exports: async (...args) => {
  calls.push(args);
  const value = responses.shift();
  if (!value) throw new Error('Unexpected network call');
  return { ok: value.status === 200, status: value.status, json: async () => value.body };
}};
const { protect } = require('../shared/auth');
const user = { id: 'user-1', email: 'parent@example.com', email_confirmed_at: '2026-01-01' };
const member = { family_id: 'FAMILY1', member_id: 'kid-1', role: 'kid' };
const req = () => ({ method: 'GET', headers: { authorization: 'Bearer valid-token' }, query: { familyId: 'FAMILY1' } });
const createFamily = require('../create-family');
const profilePin = require('../profile-pin');
test('PIN status reveals only existence for the linked profile', async () => {
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [member] }, { status: 200, body: [{ pin_hash: 'private-hash' }] }];
  const context = {}; await profilePin(context, req());
  assert.deepEqual(JSON.parse(context.res.body), { hasPin: true });
  assert.ok(calls[2][0].includes('id=eq.kid-1&family_id=eq.FAMILY1'));
});
test('children can set their own PIN without full family write permission', async () => {
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [member] }, { status: 200, body: [{ pin_hash: null }] }, { status: 200, body: { status: 200, ok: true } }];
  const context = {}; await profilePin(context, { ...req(), method: 'POST', body: { pin: '1234' } });
  assert.equal(context.res.status, 200);
  const payload = JSON.parse(calls[3][1].body);
  assert.equal(payload.p_member_id, 'kid-1'); assert.equal(payload.p_matches, true);
  assert.match(payload.p_new_hash, /^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.ok(!context.res.body.includes(payload.p_new_hash));
});
test('existing legacy PIN verifies and upgrades; wrong PIN cannot overwrite it', async () => {
  let hash = 5381; for(const digit of '1234') hash=((hash*33)^digit.charCodeAt(0))>>>0;
  for(const pin of ['1234','9999']) {
    calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [member] }, { status: 200, body: [{ pin_hash: hash.toString(16) }] }, { status: 200, body: { status: pin==='1234'?200:403 } }];
    const context = {}; await profilePin(context, { ...req(), method: 'POST', body: { pin } });
    const payload = JSON.parse(calls[3][1].body);
    assert.equal(payload.p_matches, pin==='1234');
    if(pin==='9999') assert.equal(payload.p_new_hash, null);
  }
});
test('PIN endpoint rejects other child profiles and invalid PINs', async () => {
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [member] }];
  const context = {}; await profilePin(context, { ...req(), method: 'POST', body: { pin: '1234', memberId: 'other' } });
  assert.equal(context.res.status, 403); assert.equal(calls.length, 2);
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [member] }, { status: 200, body: [{ pin_hash: null }] }];
  await profilePin(context, { ...req(), method: 'POST', body: { pin: '123' } });
  assert.equal(context.res.status, 400); assert.equal(calls.length, 3);
});
test('family creation uses verified account identity and ignores submitted IDs and roles', async () => {
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [] }, { status: 200, body: { family_id: 'NEW', role: 'parent' } }];
  const context = {};
  await createFamily(context, { ...req(), query: {}, method: 'POST', body: { familyName: ' New family ', parentName: ' Parent ', userId: 'other', familyId: 'VICTIM', role: 'admin' } });
  assert.equal(context.res.status, 200);
  assert.deepEqual(JSON.parse(calls[2][1].body), { p_user_id: user.id, p_email: user.email, p_family_name: 'New family', p_parent_name: 'Parent' });
  assert.equal(calls[2][1].headers.Authorization, 'Bearer server-only');
});
test('invalid family names never call the creation RPC', async () => {
  for (const familyName of ['', ' '.repeat(5), 'x'.repeat(81), 12]) {
    calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [] }];
    const context = {};
    await createFamily(context, { ...req(), method: 'POST', body: { familyName, parentName: 'Parent' } });
    assert.equal(context.res.status, 400); assert.equal(calls.length, 2);
  }
});
test('family creation accepts a valid unconfirmed email session during testing', async () => {
  calls = []; responses = [{ status: 200, body: { ...user, email_confirmed_at: null } }, { status: 200, body: [] }, { status: 200, body: { family_id: 'NEW', role: 'parent' } }];
  const context = {};
  await createFamily(context, { ...req(), method: 'POST', body: { familyName: 'Family', parentName: 'Parent' } });
  assert.equal(context.res.status, 200); assert.equal(calls.length, 3);
});
async function run(request, options = {}, rows = [member], authUser = user, payload = { ok: true }) {
  calls = []; responses = [{ status: 200, body: authUser }, { status: 200, body: rows }];
  let handled = false;
  const context = {};
  await protect(async ctx => { handled = true; ctx.res = { status: 200, body: JSON.stringify(payload) }; }, options)(context, request);
  return { context, handled };
}

test('missing token never reaches database or handler', async () => {
  const request = req(); request.headers = {};
  const result = await run(request);
  assert.equal(result.context.res.status, 401); assert.equal(result.handled, false); assert.equal(calls.length, 0);
});
test('invalid token is rejected by Auth', async () => {
  calls = []; responses = [{ status: 401, body: {} }];
  const context = {};
  await protect(() => assert.fail('handler reached'))(context, req());
  assert.equal(context.res.status, 401); assert.equal(calls.length, 1);
});
test('cross-family reads are forbidden', async () => {
  const request = req(); request.query.familyId = 'OTHER';
  assert.equal((await run(request)).context.res.status, 403);
});
test('conflicting body and query IDs cannot bypass membership check', async () => {
  const request = req(); request.body = { familyId: 'OTHER' };
  assert.equal((await run(request)).context.res.status, 400);
});
test('user metadata cannot grant parent role', async () => {
  const result = await run(req(), { parent: true }, [member], { ...user, user_metadata: { role: 'parent' } });
  assert.equal(result.context.res.status, 403);
});
test('child cannot write full family state or access another kid', async () => {
  const request = req(); request.method = 'POST';
  assert.equal((await run(request, { parentWrite: true })).context.res.status, 403);
  request.method = 'GET'; request.query.kidId = 'kid-2';
  assert.equal((await run(request)).context.res.status, 403);
});
test('verified parent can perform parent actions', async () => {
  const result = await run(req(), { parent: true }, [{ ...member, role: 'parent' }]);
  assert.equal(result.context.res.status, 200); assert.equal(result.handled, true);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer valid-token');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer server-only');
});
test('email confirmation is optional but anonymous accounts remain rejected', async () => {
  assert.equal((await run(req(), {}, [member], { ...user, email_confirmed_at: null })).context.res.status, 200);
  assert.equal((await run(req(), {}, [member], { ...user, is_anonymous: true })).context.res.status, 403);
  assert.equal((await run(req(), {}, [member], { ...user, email: null })).context.res.status, 403);
});
test('launch setting restores required email confirmation', async () => {
  process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
  try { assert.equal((await run(req(), {}, [member], { ...user, email_confirmed_at: null })).context.res.status, 403); }
  finally { delete process.env.REQUIRE_EMAIL_VERIFICATION; }
});
test('child responses omit password and PIN hashes and other usage', async () => {
  const result = await run(req(), { sanitize: true }, [member], user, {
    family: { passwordHash: 'secret' }, members: [{ id: 'parent', pinHash: 'secret' }],
    usage: [{ memberId: 'kid-1' }, { memberId: 'kid-2' }],
  });
  const data = JSON.parse(result.context.res.body);
  assert.equal(data.family.passwordHash, undefined); assert.equal(data.members[0].pinHash, undefined);
  assert.deepEqual(data.usage, [{ memberId: 'kid-1' }]);
});
test('a parent cannot use a kid profile from another family', async () => {
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [{ ...member, role: 'parent' }] }, { status: 200, body: [] }];
  const request = req(); request.query.kidId = 'other-family-kid';
  const context = {};
  await protect(() => assert.fail('handler reached'))(context, request);
  assert.equal(context.res.status, 403);
});
test('child can log only an owned chore and server sets the actor', async () => {
  calls = []; responses = [{ status: 200, body: user }, { status: 200, body: [member] }, { status: 200, body: [{ id: 'chore-1' }] }];
  const request = req(); request.method = 'POST'; request.body = { familyId: 'FAMILY1', choreId: 'chore-1', loggedBy: 'parent-1' };
  const context = {};
  await protect((ctx, r) => { assert.equal(r.body.loggedBy, 'kid-1'); ctx.res = { status: 200, body: '{}' }; }, { chore: true })(context, request);
  assert.equal(context.res.status, 200);
  assert.match(calls[2][0], /member_id=eq.kid-1/);
});
test('device token path delegates validation to the existing device handler', async () => {
  const result = await run({ method: 'POST', headers: {}, body: { deviceToken: 'device-secret' } }, { device: true });
  assert.equal(result.handled, true); assert.equal(calls.length, 0);
});
test('every human API exports a protected wrapper', () => {
  const fs = require('node:fs');
  const api = path.join(__dirname, '..');
  for (const folder of fs.readdirSync(api)) {
    const file = path.join(api, folder, 'index.js');
    if (!fs.existsSync(file) || ['auth-config', 'device-usage-ingest'].includes(folder)) continue;
    assert.match(fs.readFileSync(file, 'utf8'), /protect\(/, folder);
  }
});
test('public configuration never returns server credentials', async () => {
  const config = require('../auth-config');
  const original = process.env.SUPABASE_PUBLISHABLE_KEY;
  for (const key of ['sb_secret_private', `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.x`]) {
    process.env.SUPABASE_PUBLISHABLE_KEY = key;
    const context = {}; await config(context);
    assert.equal(context.res.status, 503); assert.equal(context.res.body.includes(key), false);
  }
  process.env.SUPABASE_PUBLISHABLE_KEY = original;
});

// Reproduce the production gateway replacing the standard bearer token.
test('SWA platform Authorization cannot replace the supplied Supabase token', async () => {
  const request = req();
  request.headers = { authorization: 'Bearer azure-platform-token', 'x-trackline-authorization': 'Bearer valid-token' };
  const result = await run(request);
  assert.equal(result.context.res.status, 200);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer valid-token');
});
test('malformed custom token cannot fall back to another Authorization header', async () => {
  const request = req();
  request.headers['x-trackline-authorization'] = 'not-a-bearer-token';
  const result = await run(request);
  assert.equal(result.context.res.status, 401);
  assert.equal(calls.length, 0);
});
