const fetch = require('node-fetch');
const { protect } = require('../shared/auth');

module.exports = protect(async (context, req) => {
  const { familyName, parentName } = req.body || {};
  if (![familyName, parentName].every(value => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80)) {
    context.res = { status: 400, body: JSON.stringify({ error: 'Enter a family name and your name (up to 80 characters each).' }) };
    return;
  }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/create_family_for_account`, {
    method: 'POST', timeout: 15000,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user_id: req.auth.user.id, p_email: req.auth.user.email, p_family_name: familyName.trim(), p_parent_name: parentName.trim() }),
  });
  if (!response.ok) throw Object.assign(new Error('Could not create your family. Please try again.'), { status: 503 });
  context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await response.json()) };
}, { global: true });
