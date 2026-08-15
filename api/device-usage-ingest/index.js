// Trackline device-usage-ingest API
//
// POST /api/device-usage-ingest
//   { deviceId, deviceToken, date, hours: { "09": { afk_seconds, apps:[{app,active_seconds}], sites:[{domain,active_seconds}] }, ... } }
//
// Authenticated by device token (hashed, checked against devices table) —
// NOT service_role. This is the one endpoint a laptop agent is allowed to
// call, and it can only ever affect rows tied to its own device_id — it
// cannot read anything, cannot see other devices, cannot touch any other
// table. Upserts only (on the unique (device_id,date,hour,source,name)
// constraint) — never delete-then-insert, so a crash mid-sync can't leave
// a gap with no data, per the design doc.

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
  context.log('device-usage-ingest invoked:', req.method);

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
    const { deviceId, deviceToken, date, hours } = body;
    if (!deviceId || !deviceToken || !date || !hours) {
      context.res = jsonRes(400, { error: 'deviceId, deviceToken, date, and hours are required' });
      return;
    }

    // Look up and verify the device. This is the ONLY read this endpoint
    // ever does, and it's scoped to exactly the device presenting its own
    // token — never a lookup by anything the caller doesn't already know.
    const devRes = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&select=id,family_id,member_id,hostname,device_token_hash,revoked`,
      { headers: supabaseHeaders() }
    );
    if (!devRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const devRows = await devRes.json();
    if (!devRows || devRows.length === 0) {
      context.res = jsonRes(403, { error: 'Unknown device.' });
      return;
    }
    const device = devRows[0];
    if (device.revoked) {
      context.res = jsonRes(403, { error: 'This device has been deregistered.' });
      return;
    }
    if (device.device_token_hash !== hashToken(deviceToken)) {
      context.res = jsonRes(403, { error: 'Invalid device token.' });
      return;
    }

    // Flatten the hour-bucketed payload into upsert rows.
    const rows = [];
    Object.keys(hours).forEach(hourKey => {
      const hourData = hours[hourKey] || {};
      const hourNum = parseInt(hourKey, 10);
      (hourData.apps||[]).forEach(a => {
        if(!a.app || !(a.active_seconds > 0)) return;
        rows.push({
          device_id: device.id, family_id: device.family_id, member_id: device.member_id,
          hostname: device.hostname || 'unknown', date, hour: hourNum,
          source: 'app', name: a.app, active_seconds: a.active_seconds,
          updated_at: new Date().toISOString(),
        });
      });
      (hourData.sites||[]).forEach(s => {
        if(!s.domain || !(s.active_seconds > 0)) return;
        rows.push({
          device_id: device.id, family_id: device.family_id, member_id: device.member_id,
          hostname: device.hostname || 'unknown', date, hour: hourNum,
          source: 'site', name: s.domain, active_seconds: s.active_seconds,
          updated_at: new Date().toISOString(),
        });
      });
    });

    if(rows.length > 0){
      const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/usage?on_conflict=device_id,date,hour,source,name`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      });
      if (!upsertRes.ok) {
        const bodyText = await upsertRes.text().catch(()=> '');
        context.log.error('usage upsert failed:', upsertRes.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error', status: upsertRes.status, detail: bodyText });
        return;
      }
    }

    // Best-effort last_sync_at update — not critical if this one fails.
    await fetch(`${SUPABASE_URL}/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Content-Type':'application/json', 'Prefer':'return=minimal' }),
      body: JSON.stringify({ last_sync_at: new Date().toISOString() }),
    }).catch(()=>{});

    context.res = jsonRes(200, { ok: true, rowsWritten: rows.length });
  } catch (err) {
    context.log.error('device-usage-ingest function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
