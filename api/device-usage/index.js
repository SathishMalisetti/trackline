// Trackline device-usage API (read-only) — v3, adds device sync-freshness
// info alongside the usage totals.
//
// GET /api/device-usage?familyId=X&days=7
//
// Returns { usage, devices }:
//   - usage: aggregated per (member, hostname, date) minute totals, same
//     shape as before — no change needed anywhere already using it.
//   - devices: every device paired to this family, with lastSyncAt, so the
//     UI can show "no data since X" for a device that's gone quiet —
//     rather than that device just silently vanishing from the usage list
//     the moment it stops reporting, which would look identical to "0
//     minutes used" and hide the gap entirely. Not sensitive data (no
//     tokens), so this doesn't need password-gating like device-list does.

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
  context.log('device-usage invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'GET') {
    context.res = jsonRes(405, { error: 'Method not allowed — this endpoint is read-only.' });
    return;
  }

  try {
    const familyId = (req.query && req.query.familyId) || '';
    if (!familyId) {
      context.res = jsonRes(400, { error: 'familyId is required' });
      return;
    }
    const days = Math.min(90, Math.max(1, parseInt((req.query && req.query.days) || '7', 10) || 7));
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - (days - 1));
    const sinceISO = sinceDate.toISOString().slice(0,10);

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/usage?family_id=eq.${encodeURIComponent(familyId)}&date=gte.${sinceISO}&select=member_id,hostname,date,active_seconds`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) {
      const bodyText = await res.text().catch(()=> '');
      context.log.error('Supabase usage GET failed:', res.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
      return;
    }
    const rows = await res.json();

    // Aggregate every app/site row down to one total-minutes figure per
    // (member, hostname, date) — the frontend just wants "how long was
    // this device used that day," not the per-app breakdown, for now.
    const totals = {}; // memberId -> hostname -> date -> total seconds
    rows.forEach(r => {
      const memberId = r.member_id, hostname = r.hostname, date = r.date;
      totals[memberId] = totals[memberId] || {};
      totals[memberId][hostname] = totals[memberId][hostname] || {};
      totals[memberId][hostname][date] = (totals[memberId][hostname][date] || 0) + Number(r.active_seconds || 0);
    });
    const usage = [];
    Object.keys(totals).forEach(memberId => {
      Object.keys(totals[memberId]).forEach(hostname => {
        Object.keys(totals[memberId][hostname]).forEach(date => {
          usage.push({ memberId, deviceName: hostname, date, minutesUsed: Math.round(totals[memberId][hostname][date] / 60) });
        });
      });
    });

    // Also fetch every device paired to this family, for sync-freshness
    // reporting — deliberately NOT scoped to the `days` window, since a
    // device that's been silent for a while is exactly what we want to
    // surface, not filter out.
    const devRes = await fetch(
      `${SUPABASE_URL}/rest/v1/devices?family_id=eq.${encodeURIComponent(familyId)}&select=id,member_id,hostname,label,last_sync_at`,
      { headers: supabaseHeaders() }
    );
    let devices = [];
    if (devRes.ok) {
      const devRows = await devRes.json();
      devices = devRows.map(d => ({
        id: d.id, memberId: d.member_id, hostname: d.hostname, label: d.label, lastSyncAt: d.last_sync_at,
      }));
    } else {
      context.log.error('devices GET failed (non-fatal for this endpoint):', devRes.status);
    }

    context.res = jsonRes(200, { usage, devices });
  } catch (err) {
    context.log.error('device-usage function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
