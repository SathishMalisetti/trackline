// Trackline device-deregister API
//
// POST /api/device-deregister
//   Device removing itself:  { deviceId, deviceToken }
//   Parent removing a device: { familyId, passwordHash, deviceId }
//
// Either path leads to genuine deletion — the device row is deleted, which
// cascades (via foreign key) to delete every usage row tied to it. This is
// "delete app, delete whole data" — not a soft-revoke that leaves history
// sitting in the database.

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
function hashToken(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = async function (context, req) {
  context.log('device-deregister invoked:', req.method);

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
    const { deviceId, deviceToken, familyId, passwordHash } = body;
    if (!deviceId) {
      context.res = jsonRes(400, { error: 'deviceId is required' });
      return;
    }

    const devRes = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&select=id,family_id,device_token_hash`,
      { headers: supabaseHeaders() }
    );
    if (!devRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const devRows = await devRes.json();
    if (!devRows || devRows.length === 0) {
      // Already gone — treat as success, since the end state (device doesn't exist) is achieved either way.
      context.res = jsonRes(200, { ok: true, alreadyGone: true });
      return;
    }
    const device = devRows[0];

    let authorized = false;
    if (deviceToken) {
      authorized = device.device_token_hash === hashToken(deviceToken);
    } else if (familyId && passwordHash) {
      const famRes = await fetch(
        `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=password_hash`,
        { headers: supabaseHeaders() }
      );
      const famRows = famRes.ok ? await famRes.json() : [];
      authorized = famRows.length > 0 && famRows[0].password_hash === passwordHash && device.family_id === familyId;
    }

    if (!authorized) {
      context.res = jsonRes(403, { error: 'Not authorized to remove this device.' });
      return;
    }

    // Genuine delete — cascades to every usage row for this device via the foreign key.
    const delRes = await fetch(`${SUPABASE_URL}/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: supabaseHeaders({ 'Prefer':'return=minimal' }),
    });
    if (!delRes.ok) {
      const bodyText = await delRes.text().catch(()=> '');
      context.log.error('device delete failed:', delRes.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: delRes.status, detail: bodyText });
      return;
    }

    context.res = jsonRes(200, { ok: true });
  } catch (err) {
    context.log.error('device-deregister function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
