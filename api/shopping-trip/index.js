// Trackline shopping-trip API
//
// POST   /api/shopping-trip  { familyId, trip }
//   -> upserts one whole trip object (including its items array) as a
//      single row. Same "whole object, one row" pattern as family-data,
//      just scoped to a single trip instead of the whole family.
// DELETE /api/shopping-trip?familyId=X&tripId=Y
//   -> removes that trip.
//
// Trips live in their own table (shopping_lists) for the same reason
// chore_logs does: they accumulate forever (a weekly grocery run = 52+/year)
// while everything else in a family's data stays roughly constant in size.
//
// Uses the same SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY server-only
// settings as family-data and chore-log.

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

module.exports = async function (context, req) {
  context.log('shopping-trip invoked:', req.method, req.query);

  if(!SUPABASE_URL || !SERVICE_KEY){
    context.log.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY app settings');
    context.res = jsonRes(500, { error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured on the server.' });
    return;
  }

  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const familyId = body.familyId;
      const trip = body.trip;
      if (!familyId || !trip || !trip.id) {
        context.res = jsonRes(400, { error: 'familyId and trip (with an id) are required' });
        return;
      }
      const res = await fetch(`${SUPABASE_URL}/rest/v1/shopping_lists?on_conflict=id`, {
        method: 'POST',
        headers: supabaseHeaders({
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        }),
        body: JSON.stringify({
          id: trip.id,
          family_id: familyId,
          date: trip.date || null,
          data: trip,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase shopping_lists POST failed:', res.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
        return;
      }
      context.res = jsonRes(200, { ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const familyId = (req.query && req.query.familyId) || '';
      const tripId = (req.query && req.query.tripId) || '';
      if (!familyId || !tripId) {
        context.res = jsonRes(400, { error: 'familyId and tripId are required' });
        return;
      }
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/shopping_lists?id=eq.${encodeURIComponent(tripId)}&family_id=eq.${encodeURIComponent(familyId)}`,
        { method: 'DELETE', headers: supabaseHeaders({ 'Prefer': 'return=minimal' }) }
      );
      if (!res.ok) {
        const bodyText = await res.text().catch(()=> '');
        context.log.error('Supabase shopping_lists DELETE failed:', res.status, bodyText);
        context.res = jsonRes(502, { error: 'Upstream database error', status: res.status, detail: bodyText });
        return;
      }
      context.res = jsonRes(200, { ok: true });
      return;
    }

    context.res = jsonRes(405, { error: 'Method not allowed' });
  } catch (err) {
    context.log.error('shopping-trip function threw:', err && err.stack ? err.stack : err);
    context.res = jsonRes(500, { error: 'Server error', detail: String(err && err.message || err) });
  }
};
