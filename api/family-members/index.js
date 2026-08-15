// Trackline family-members API
//
// POST /api/family-members  { familyId, passwordHash }
//
// Password-gated (same pattern as export-family/device-list) — returns
// just { id, name, role } for every family member, nothing else. Built
// specifically so the device-pairing GUI can show a real "Mia / Leo / Dad"
// dropdown instead of asking a parent to go find and type a raw member ID.

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
  context.log('family-members invoked:', req.method);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }
  if (req.method !== 'POST') {
    context.res = jsonRes(405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    const { familyId, passwordHash } = body;
    if (!familyId || !passwordHash) {
      context.res = jsonRes(400, { error: 'familyId and passwordHash are required' });
      return;
    }

    const famRes = await fetch(
      `${SUPABASE_URL}/rest/v1/families?id=eq.${encodeURIComponent(familyId)}&select=password_hash`,
      { headers: supabaseHeaders() }
    );
    if (!famRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const famRows = await famRes.json();
    if (!famRows || famRows.length === 0 || famRows[0].password_hash !== passwordHash) {
      context.res = jsonRes(403, { error: 'Incorrect family ID or password.' });
      return;
    }

    const memRes = await fetch(
      `${SUPABASE_URL}/rest/v1/members?family_id=eq.${encodeURIComponent(familyId)}&select=id,name,role&order=role.asc,name.asc`,
      { headers: supabaseHeaders() }
    );
    if (!memRes.ok) { context.res = jsonRes(502, { error: 'Upstream database error' }); return; }
    const rows = await memRes.json();
    const members = rows.map(r => ({ id: r.id, name: r.name, role: r.role }));

    context.res = jsonRes(200, { members });
  } catch (err) {
    context.log.error('family-members function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
