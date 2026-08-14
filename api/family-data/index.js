// Trackline family-data API (v5 — adds shopping trips merge, same pattern as chore_logs)
//
// Everything from v4 unchanged (node-fetch, explicit response bodies).
// New in v5: also fetches this family's shopping trips from their own table
// and merges them into the GET response as data.shoppingTrips — exactly the
// same pattern already used for choreLogs, since trips have the same
// "grows every day forever" shape that justified giving choreLogs its own
// table in the first place.
//
// Required Application Settings (server-only):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

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

async function fetchChoreLogsForFamily(familyId){
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chore_logs?family_id=eq.${encodeURIComponent(familyId)}&select=id,chore_id,date,completed_at,logged_by,created_at`,
    { headers: supabaseHeaders() }
  );
  if(!res.ok) return [];
  const rows = await res.json();
  return rows.map(r => ({
    id: r.id,
    choreId: r.chore_id,
    date: r.date,
    completedAt: r.completed_at,
    loggedBy: r.logged_by,
    timestamp: r.created_at,
  }));
}

async function fetchTripsForFamily(familyId){
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shopping_lists?family_id=eq.${encodeURIComponent(familyId)}&select=data`,
    { headers: supabaseHeaders() }
  );
  if(!res.ok) return [];
  const rows = await res.json();
  return rows.map(r => r.data); // each row's data column IS the whole trip object
}

module.exports = async function (context, req) {
  context.log('family-data invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY app settings');
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const familyId = (req.query && req.query.familyId) || '';
      if (!familyId) {
        context.res = jsonRes(400, { error: 'familyId is required' });
        return;
      }

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=data`,
        { headers: supabaseHeaders() }
      );

      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase families GET failed:', res.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
        return;
      }

      const rows = await res.json();
      context.log('families query returned', rows ? rows.length : 0, 'row(s) for familyId', familyId);

      if (!rows || rows.length === 0) {
        context.res = jsonRes(200, null);
        return;
      }

      const data = rows[0].data;
      data.choreLogs = await fetchChoreLogsForFamily(familyId);
      data.shoppingTrips = await fetchTripsForFamily(familyId);
      context.res = jsonRes(200, data);
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const familyId = body.familyId;
      const data = body.data;
      if (!familyId || !data) {
        context.res = jsonRes(400, { error: 'familyId and data are required' });
        return;
      }
      const { choreLogs, shoppingTrips, ...rest } = data;
      const res = await fetch(`${SUPABASE_URL}/rest/v1/families?on_conflict=id`, {
        method: 'POST',
        headers: supabaseHeaders({
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({ id: familyId, data: rest, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase families POST failed:', res.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
        return;
      }
      context.res = jsonRes(200, { ok: true });
      return;
    }

    context.res = jsonRes(405, { error: 'Method not allowed' });
  } catch (err) {
    context.log.error('family-data function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
