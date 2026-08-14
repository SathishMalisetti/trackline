// Trackline family-data API (v6 — relational storage via Postgres functions)
//
// Same external behavior as v5 (GET/POST, same response shape) but the
// database itself now stores members/events/chores/etc. in real tables
// instead of one JSONB blob. The decomposition (on save) and reassembly
// (on read) happens INSIDE Postgres via two functions — save_family_data
// and get_family_data — called here as simple RPC calls. This keeps this
// Function's code (and the frontend, which needs zero changes) almost
// identical to before, while the actual stored data is now fully relational.
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
    id: r.id, choreId: r.chore_id, date: r.date,
    completedAt: r.completed_at, loggedBy: r.logged_by, timestamp: r.created_at,
  }));
}

async function fetchTripsForFamily(familyId){
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/shopping_lists?family_id=eq.${encodeURIComponent(familyId)}&select=data`,
    { headers: supabaseHeaders() }
  );
  if(!res.ok) return [];
  const rows = await res.json();
  return rows.map(r => r.data);
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

      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_family_data`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_family_id: familyId }),
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('get_family_data RPC failed:', res.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
        return;
      }

      const data = await res.json(); // the jsonb result, or null if not found
      if (!data) {
        context.res = jsonRes(200, null);
        return;
      }

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

      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_family_data`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ p_family_id: familyId, p_data: rest }),
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('save_family_data RPC failed:', res.status, bodyText);
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
