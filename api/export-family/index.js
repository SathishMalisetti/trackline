// Trackline export-family API
//
// POST /api/export-family  { familyId, passwordHash }
//
// This closes a real gap: previously "export" just dumped whatever was in
// the browser's memory to a file — anyone with the app open could export,
// and separately, the old family-data GET returned full data (including PIN
// hashes) to anyone who merely knew the family ID, with password-checking
// only happening in the browser afterward (easy to bypass by calling the
// API directly). This endpoint fixes both: the password is verified HERE,
// server-side, before any data is returned — and PIN/family-password hashes
// are stripped from the response entirely, so an exported backup file never
// carries them around.
//
// The client sends a HASH of the password (same simpleHash() already used
// for login), never the plaintext — consistent with how login already works.

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
  context.log('export-family invoked:', req.method);

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

    // Verify the password FIRST, before touching any of the family's real data.
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
      // Deliberately the same error as a wrong password — don't reveal whether the ID exists.
      context.res = jsonRes(403, { error: 'Incorrect family ID or password.' });
      return;
    }
    if (famRows[0].password_hash !== passwordHash) {
      context.res = jsonRes(403, { error: 'Incorrect family ID or password.' });
      return;
    }

    // Password verified — now assemble the export via the same relational read as family-data.
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

    // Strip anything sensitive before it ever leaves the server — an exported
    // file should never carry PIN hashes or the family password hash around.
    if (data.family) delete data.family.passwordHash;
    if (Array.isArray(data.members)) {
      data.members.forEach(m => { delete m.pinHash; });
    }

    context.res = jsonRes(200, { exportedAt: new Date().toISOString(), data });
  } catch (err) {
    context.log.error('export-family function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
