// Trackline device-usage API (read-only)
//
// GET /api/device-usage?familyId=X&days=7
//
// Returns device usage rows for the given family, most recent `days` days
// (default 7). This endpoint is deliberately GET-only — Trackline itself
// never writes usage data; that's the job of a separate, future collector
// inserting directly into the device_usage table via service_role.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function jsonRes(status, obj){
  return {
    status: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj === undefined ? null : obj),
  };
}

function supabaseHeaders(extra){
  return Object.assign({
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
  }, extra || {});
}

module.exports = async function (context, req) {
  context.log('device-usage invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY app settings');
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
      `${SUPABASE_URL}/rest/v1/device_usage?family_id=eq.${encodeURIComponent(familyId)}&date=gte.${sinceISO}&select=id,member_id,device_name,category,date,minutes_used,source&order=date.desc`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) {
      const bodyText = await res.text().catch(()=> '');
      context.log.error('Supabase device_usage GET failed:', res.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
      return;
    }
    const rows = await res.json();
    const usage = rows.map(r => ({
      id: r.id, memberId: r.member_id, deviceName: r.device_name,
      category: r.category, date: r.date, minutesUsed: r.minutes_used, source: r.source,
    }));
    context.res = jsonRes(200, { usage });
  } catch (err) {
    context.log.error('device-usage function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
