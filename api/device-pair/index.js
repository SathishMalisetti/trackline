// Trackline device-pair API
//
// POST /api/device-pair  { familyId, passwordHash, memberId, hostname, label }
//
// Parent-initiated only — verifies the family password server-side (same
// pattern as join-family/export-family) before creating anything. Returns
// a device_id and a RAW device token exactly once — like a GitHub personal
// access token, it's never retrievable again after this response. Only its
// hash is stored. That raw token is what the laptop agent's config.json
// holds and sends with every future request.

const fetch = require('node-fetch');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}
function randomId(len){
  return crypto.randomBytes(len).toString('base64url').slice(0, len);
}
function hashToken(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = async function (context, req) {
  context.log('device-pair invoked:', req.method);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'POST') {
    context.res = jsonRes(405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const { familyId, passwordHash, memberId, hostname, label } = body;
    if (!familyId || !passwordHash || !memberId) {
      context.res = jsonRes(400, { error: 'familyId, passwordHash, and memberId are required' });
      return;
    }

    // Verify the family password FIRST, same as join-family/export-family.
    const famRes = await fetch(
      `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=password_hash`,
      { headers: supabaseHeaders() }
    );
    if (!famRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const famRows = await famRes.json();
    if (!famRows || famRows.length === 0 || famRows[0].password_hash !== passwordHash) {
      context.res = jsonRes(403, { error: 'Incorrect family ID or password.' });
      return;
    }

    // Verify the member actually exists in this family
    const memRes = await fetch(
      `${SUPABASE_URL}/rest/v1/members?id=eq.${encodeURIComponent(memberId)}&family_id=eq.${encodeURIComponent(familyId)}&select=id`,
      { headers: supabaseHeaders() }
    );
    const memRows = memRes.ok ? await memRes.json() : [];
    if (!memRows || memRows.length === 0) {
      context.res = jsonRes(404, { error: 'That family member was not found.' });
      return;
    }

    const deviceId = 'dev_' + randomId(16);
    const rawToken = randomId(40);
    const tokenHash = hashToken(rawToken);

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/devices`, {
      method: 'POST',
      headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        id: deviceId, family_id: familyId, member_id: memberId,
        hostname: hostname || null, label: label || null,
        device_token_hash: tokenHash, revoked: false,
      }),
    });
    if (!insertRes.ok) {
      const bodyText = await insertRes.text().catch(()=> '');
      context.log.error('devices insert failed:', insertRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: insertRes.status, detail: bodyText });
      return;
    }

    // The raw token is returned exactly once, right here — never again.
    context.res = jsonRes(200, { deviceId, deviceToken: rawToken });
  } catch (err) {
    context.log.error('device-pair function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
