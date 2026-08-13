// Trackline chore-log API (v3 — explicit node-fetch, defensive logging)
// Same behavior as v2 — see family-data/index.js for the reasoning behind
// using node-fetch explicitly and returning real error bodies on failure.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supabaseHeaders(extra){
  return Object.assign({
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
  }, extra || {});
}

module.exports = async function (context, req) {
  context.log('chore-log invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY app settings');
    context.res = { status: 500, jsonBody: { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' } };
    return;
  }

  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const { familyId, id, choreId, date, completedAt, loggedBy } = body;
      if (!familyId || !choreId || !date || !completedAt) {
        context.res = { status: 400, jsonBody: { error: 'familyId, choreId, date, and completedAt are required' } };
        return;
      }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/chore_logs`, {
        method: 'POST',
        headers: supabaseHeaders({ 'Content-Type': 'application/json', 'Prefer': 'return=minimal' }),
        body: JSON.stringify({
          id: id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
          family_id: familyId,
          chore_id: choreId,
          date: date,
          completed_at: completedAt,
          logged_by: loggedBy || null,
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase chore_logs POST failed:', res.status, bodyText);
        context.res = { status: 502, jsonBody: { error: 'Upstream database error', status: res.status, detail: bodyText } };
        return;
      }
      context.res = { status: 200, jsonBody: { ok: true } };
      return;
    }

    if (req.method === 'DELETE') {
      const familyId = (req.query && req.query.familyId) || '';
      const choreId = (req.query && req.query.choreId) || '';
      const date = (req.query && req.query.date) || '';
      if (!familyId || !choreId || !date) {
        context.res = { status: 400, jsonBody: { error: 'familyId, choreId, and date are required' } };
        return;
      }
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/chore_logs?family_id=eq.${encodeURIComponent(familyId)}&chore_id=eq.${encodeURIComponent(choreId)}&date=eq.${encodeURIComponent(date)}`,
        { method: 'DELETE', headers: supabaseHeaders({ 'Prefer': 'return=minimal' }) }
      );
      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase chore_logs DELETE failed:', res.status, bodyText);
        context.res = { status: 502, jsonBody: { error: 'Upstream database error', status: res.status, detail: bodyText } };
        return;
      }
      context.res = { status: 200, jsonBody: { ok: true } };
      return;
    }

    context.res = { status: 405, jsonBody: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('chore-log function threw:', err && err.stack ? err.stack : err);
    context.res = { status: 500, jsonBody: { error: 'Server error', detail: String(err && err.message || err) } };
  }
};
