const fetch = require('node-fetch');
const { protect } = require('../shared/auth');
const { hashSecret: hashPin, matchesSecret: matchesPin } = require('../shared/credentials');
module.exports = protect(async (context, req) => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const familySession = req.auth.familySession;
  const memberId = familySession ? (req.body || {}).memberId || (req.query || {}).memberId : req.membership.member_id;
  const familyId = familySession ? familySession.family_id : req.membership.family_id;
  if (!memberId) throw Object.assign(new Error('Choose a family member.'), { status: 400 });
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/members?id=eq.${encodeURIComponent(memberId)}&family_id=eq.${encodeURIComponent(familyId)}&select=pin_hash`, { headers, timeout: 10000 });
  if (!response.ok) throw Object.assign(new Error('Could not check your PIN.'), { status: 503 });
  const [member] = await response.json();
  if (!member) throw Object.assign(new Error('Your linked profile was not found.'), { status: 403 });
  if (req.method === 'GET') {
    context.res = { status: 200, body: JSON.stringify({ hasPin: !!member.pin_hash }) };
    return;
  }
  const pin = req.body && req.body.pin;
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw Object.assign(new Error('PIN must be exactly 4 digits.'), { status: 400 });
  const matches = !member.pin_hash || await matchesPin(pin, member.pin_hash);
  const newHash = matches && (!member.pin_hash || !member.pin_hash.startsWith('scrypt:')) ? await hashPin(pin) : null;
  const result = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${familySession ? 'unlock_family_profile' : 'check_profile_pin_attempt'}`, {
    method: 'POST', headers, timeout: 10000,
    body: JSON.stringify({ p_member_id: memberId, ...(familySession ? { p_token_hash: familySession.token_hash } : { p_family_id: familyId }), p_observed_hash: member.pin_hash, p_matches: matches, p_new_hash: newHash }),
  });
  if (!result.ok) throw Object.assign(new Error('Could not check your PIN. Please try again.'), { status: 503 });
  const outcome = await result.json();
  context.res = { status: outcome.status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outcome) };
}, { familyEntry: true });
