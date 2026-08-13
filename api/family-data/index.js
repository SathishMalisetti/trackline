// Trackline family-data API (v2 — Supabase-backed, credentials server-only)
//
// GET  /api/family-data?familyId=xxx
//   -> returns the family's data (family, members, events, chores, choreLibrary)
//      with choreLogs merged back in from the separate chore_logs table, or null.
// POST /api/family-data  { familyId, data }
//   -> upserts the family blob. `data` should NOT include choreLogs — those are
//      synced individually through /api/chore-log instead (see that function).
//
// Required Application Settings on this Static Web App (server-only, never
// sent to the browser):
//   SUPABASE_URL              e.g. https://xxxxxxxxxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY the "service_role" key (NOT anon) — bypasses
//                              Row Level Security, which is exactly what a
//                              trusted server-side caller is supposed to do.
//                              Never put this key in frontend code.

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
  if(!SUPABASE_URL || !SERVICE_KEY){
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
        context.res = { status: 502, jsonBody: { error: 'Upstream database error' } };
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
      // choreLogs are synced separately — never store them in this blob even
      // if a caller accidentally includes them.
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
        context.res = { status: 502, jsonBody: { error: 'Upstream database error' } };
        return;
      }
      context.res = { status: 200, jsonBody: { ok: true } };
      return;
    }

    context.res = { status: 405, jsonBody: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('family-data function error:', err);
    context.res = { status: 500, jsonBody: { error: 'Server error' } };
  }
};
