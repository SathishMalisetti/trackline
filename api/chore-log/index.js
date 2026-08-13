// Trackline chore-log API
//
// POST   /api/chore-log  { familyId, choreId, date, completedAt, loggedBy }
//   -> inserts one completion record.
// DELETE /api/chore-log?familyId=X&choreId=Y&date=Z
//   -> removes that completion record (the "undo" action).
//
// This is deliberately a separate table/endpoint from family-data: completion
// logs grow every single day forever, while everything else in a family's
// data stays roughly constant in size. Keeping logs separate means checking
// off one task is a single small insert, not a rewrite of the whole family
// record.
//
// Uses the same SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY server-only settings
// as family-data.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function supabaseHeaders(extra){
  return Object.assign({
    'apikey': SERVICE_KEY,
    'Authorization': `Bearer ${SERVICE_KEY}`,
  }, extra || {});
}

module.exports = async function (context, req) {
  if(!SUPABASE_URL || !SERVICE_KEY){
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
        context.res = { status: 502, jsonBody: { error: 'Upstream database error' } };
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
        context.res = { status: 502, jsonBody: { error: 'Upstream database error' } };
        return;
      }
      context.res = { status: 200, jsonBody: { ok: true } };
      return;
    }

    context.res = { status: 405, jsonBody: { error: 'Method not allowed' } };
  } catch (err) {
    context.log.error('chore-log function error:', err);
    context.res = { status: 500, jsonBody: { error: 'Server error' } };
  }
};
