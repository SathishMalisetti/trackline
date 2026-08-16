// Trackline device-usage-detail API (read-only)
//
// GET /api/device-usage-detail?familyId=X&memberId=Y&date=2026-08-16
//
// Returns the top apps (and sites, separately) for one family member on
// one specific day — aggregated across every hour and every distinct
// title, since a "top programs" view cares about total time per app, not
// fragmenting chrome.exe into one row per browser tab title.

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
  context.log('device-usage-detail invoked:', req.method, req.query);

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
    const memberId = (req.query && req.query.memberId) || '';
    const date = (req.query && req.query.date) || '';
    if (!familyId || !memberId || !date) {
      context.res = jsonRes(400, { error: 'familyId, memberId, and date are all required' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      context.res = jsonRes(400, { error: 'date must be in YYYY-MM-DD format' });
      return;
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/usage?family_id=eq.${encodeURIComponent(familyId)}&member_id=eq.${encodeURIComponent(memberId)}&date=eq.${date}&select=source,name,category,active_seconds`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) {
      const bodyText = await res.text().catch(()=> '');
      context.log.error('Supabase usage GET failed:', res.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
      return;
    }
    const rows = await res.json();

    // Group by (source, name) — collapses every hour and every distinct
    // title into one total-time figure per app/site, which is what a
    // "top programs" view actually wants.
    const appTotals = {}, siteTotals = {};
    const appCategory = {}, siteCategory = {};
    rows.forEach(r => {
      const bucket = r.source === 'site' ? siteTotals : appTotals;
      const catBucket = r.source === 'site' ? siteCategory : appCategory;
      bucket[r.name] = (bucket[r.name] || 0) + Number(r.active_seconds || 0);
      catBucket[r.name] = r.category || 'Uncategorized'; // same app should always carry the same category; last-write is fine
    });

    const toSortedList = (totals, categories) =>
      Object.keys(totals)
        .map(name => ({ name, category: categories[name], minutesUsed: Math.round(totals[name] / 60) }))
        .filter(item => item.minutesUsed > 0)
        .sort((a, b) => b.minutesUsed - a.minutesUsed);

    context.res = jsonRes(200, {
      date,
      apps: toSortedList(appTotals, appCategory),
      sites: toSortedList(siteTotals, siteCategory),
    });
  } catch (err) {
    context.log.error('device-usage-detail function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
