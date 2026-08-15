// Trackline join-family API
//
// POST /api/join-family  { familyId, passwordHash }
//
// Closes the same class of gap that export-family closed, for the "join
// this family on a new device" flow specifically: previously the app
// fetched a family's ENTIRE data (every PIN hash included) before ever
// checking the password — the check only happened in the browser
// afterward, trivially bypassed by calling the API directly. This endpoint
// verifies the password server-side FIRST.
//
// Unlike export-family, this does NOT strip pinHash — a device that
// legitimately joins needs those intact so existing members can keep using
// their existing PIN rather than being forced to reset it. This is safe
// because the password gate now genuinely happened first, server-side.

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
  context.log('join-family invoked:', req.method);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY app settings');
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'POST') {
    context.res = jsonRes(405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const familyId = body.familyId;
    const passwordHash = body.passwordHash;
    if (!familyId || !passwordHash) {
      context.res = jsonRes(400, { error: 'familyId and passwordHash are required' });
      return;
    }

    // Verify the password FIRST, before touching any real data.
    const famRes = await fetch(
      `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=password_hash`,
      { headers: supabaseHeaders() }
    );
    if (!famRes.ok) {
      context.res = jsonRes(502, { error: 'Upstream database error' });
      return;
    }
    const famRows = await famRes.json();
    if (!famRows || famRows.length === 0) {
      // Same error whether the ID doesn't exist or the password is wrong —
      // don't reveal which, so a wrong guess can't be used to enumerate IDs.
      context.res = jsonRes(403, { error: 'No family found with that ID and password.' });
      return;
    }
    if (!famRows[0].password_hash) {
      context.res = jsonRes(409, { error: 'This family doesn\'t have a password set yet — ask the parent who created it to set one in Settings.' });
      return;
    }
    if (famRows[0].password_hash !== passwordHash) {
      context.res = jsonRes(403, { error: 'No family found with that ID and password.' });
      return;
    }

    // Password verified — now assemble the full, usable data set.
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_family_data`, {
      method: 'POST',
      headers: supabaseHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ p_family_id: familyId }),
    });
    if (!rpcRes.ok) {
      context.res = jsonRes(502, { error: 'Upstream database error' });
      return;
    }
    const data = await rpcRes.json();
    if (!data) {
      context.res = jsonRes(404, { error: 'Family not found' });
      return;
    }

    data.choreLogs = await fetchChoreLogsForFamily(familyId);
    data.shoppingTrips = await fetchTripsForFamily(familyId);

    context.res = jsonRes(200, data);
  } catch (err) {
    context.log.error('join-family function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
