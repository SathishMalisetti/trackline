// Trackline family-data API (v3 — explicit node-fetch, defensive logging)
//
// Same behavior as v2, with two reliability fixes:
//  1. Uses the 'node-fetch' package explicitly instead of relying on the
//     Function runtime's built-in fetch (which isn't guaranteed to exist
//     depending on the exact Node version Azure picks for this app).
//  2. Wraps everything so a failure always returns a real error response
//     with a message, instead of the function crashing silently and the
//     caller seeing a blank response with no explanation.
//
// Required Application Settings (server-only):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

module.exports = async function (context, req) {
  context.log('family-data invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY app settings');
    context.res = { status: 500, jsonBody: { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' } };
    return;
  }

  try {
    if (req.method === 'GET') {
      const familyId = (req.query && req.query.familyId) || '';
      if (!familyId) {
        context.res = { status: 400, jsonBody: { error: 'familyId is required' } };
        return;
      }

      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=data`,
        { headers: supabaseHeaders() }
      );

      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase families GET failed:', res.status, bodyText);
        context.res = { status: 502, jsonBody: { error: 'Upstream database error', status: res.status, detail: bodyText } };
        return;
      }

      const rows = await res.json();
      if (!rows || rows.length === 0) {
        context.res = { status: 200, jsonBody: null };
        return;
      }

      const data = rows[0].data;
      data.choreLogs = await fetchChoreLogsForFamily(familyId);
      context.res = { status: 200, jsonBody: data };
      return;
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const familyId = body.familyId;
      const data = body.data;
      if (!familyId || !data) {
        context.res = { status: 400, jsonBody: { error: 'familyId and data are required' } };
        return;
      }
      const { choreLogs, ...rest } = data;
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
        context.res = { status: 502, jsonBody: { error: 'Upstream database error', status: res.status, detail: bodyText } };
        return;
      }
      context.res = { status: 200, jsonBody: { ok: true } };
      return;
    }

    context.res = { status: 405, jsonBody: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('family-data function threw:', err && err.stack ? err.stack : err);
    context.res = { status: 500, jsonBody: { error: 'Server error', detail: String(err && err.message || err) } };
  }
};
