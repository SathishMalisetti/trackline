// Trackline device-usage-detail API (read-only)
//
// GET /api/device-usage-detail?familyId=X&memberId=Y&date=2026-08-16
//
// Returns the top apps (and sites, separately) for one family member on
// one specific day — aggregated across hours, preserving each distinct
// title. Titles remain separate so parents can identify the game or activity.

const fetch = require('node-fetch');
const {usageCategory} = require('../shared/usage-category');

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
      `${SUPABASE_URL}/rest/v1/usage?family_id=eq.${encodeURIComponent(familyId)}&member_id=eq.${encodeURIComponent(memberId)}&date=eq.${date}&select=source,name,title,category,active_seconds`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) {
      const bodyText = await res.text().catch(()=> '');
      context.log.error('Supabase usage GET failed:', res.status, bodyText);
      context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
      return;
    }
    const rows = await res.json();

    // Retain title/category distinctions instead of hiding Minecraft behind javaw.exe.
    const apps = new Map(), sites = new Map();
    rows.forEach(r => {
      const bucket = r.source === 'site' ? sites : apps;
      const title = r.source === 'site' ? '' : (r.title || '');
      const category = r.source === 'site' ? (r.category || 'Uncategorized')
        : (usageCategory(r.name, title, r.category) || 'Uncategorized');
      const key = JSON.stringify([r.name, title, category]);
      if (!bucket.has(key)) bucket.set(key, {name:r.name, title, category, seconds:0});
      bucket.get(key).seconds += Number(r.active_seconds || 0);
    });
    const toSortedList = bucket => [...bucket.values()]
      .map(({seconds,...item}) => ({...item, minutesUsed:Math.round(seconds/60)}))
      .filter(item => item.minutesUsed > 0)
      .sort((a,b) => b.minutesUsed-a.minutesUsed || a.name.localeCompare(b.name) || a.title.localeCompare(b.title));

    const categorySeconds = new Map();
    for(const app of apps.values()) categorySeconds.set(app.category,(categorySeconds.get(app.category)||0)+app.seconds);
    context.res = jsonRes(200, {
      date,
      totalMinutes: Math.round([...apps.values()].reduce((sum,a)=>sum+a.seconds,0)/60),
      categoryTotals: Object.fromEntries([...categorySeconds].map(([category,seconds])=>[category,Math.round(seconds/60)])),
      apps: toSortedList(apps),
      sites: toSortedList(sites),
    });
  } catch (err) {
    context.log.error('device-usage-detail function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};

module.exports = require('../shared/auth').protect(module.exports, {});
