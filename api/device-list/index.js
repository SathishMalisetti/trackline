// Trackline device-list API
//
// POST /api/device-list  { familyId, passwordHash }
//
// Password-gated (same pattern as export-family) — lists every device
// paired to this family, for the parent-facing "Registered devices"
// management screen in Settings. Read-only.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function jsonRes(status, obj){
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj === undefined ? null : obj) };
}
function supabaseHeaders(extra){
  return Object.assign({ 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` }, extra || {});
}

module.exports = async function (context, req) {
  context.log('device-list invoked:', req.method);

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
    const { familyId, passwordHash } = body;
    if (!familyId || !passwordHash) {
      context.res = jsonRes(400, { error: 'familyId and passwordHash are required' });
      return;
    }

    const famRes = await fetch(
      `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=password_hash`,
      { headers: supabaseHeaders() }
    );
    if (!famRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const famRows = await famRes.json();
    if (!famRows || famRows.length === 0 || famRows[0].password_hash !== passwordHash) {
      context.res = jsonRes(403, { error: 'Incorrect family password.' });
      return;
    }

    const devRes = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?family_id=eq.${encodeURIComponent(familyId)}&select=id,member_id,hostname,label,paired_at,last_sync_at&order=paired_at.desc`,
      { headers: supabaseHeaders() }
    );
    if (!devRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const rows = await devRes.json();
    const devices = rows.map(r => ({
      id: r.id, memberId: r.member_id, hostname: r.hostname, label: r.label,
      pairedAt: r.paired_at, lastSyncAt: r.last_sync_at,
    }));
    context.res = jsonRes(200, { devices });
  } catch (err) {
    context.log.error('device-list function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
