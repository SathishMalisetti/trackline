const fetch = require('node-fetch');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { protect } = require('../shared/auth');
const scrypt = promisify(crypto.scrypt);
const hashPin = async pin => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(pin, salt, 32)).toString('hex')}`;
};
async function matchesPin(pin, hash) {
  if (!hash) return false;
  if (hash.startsWith('scrypt:')) {
    const [, salt, expected] = hash.split(':');
    if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
    return crypto.timingSafeEqual(await scrypt(pin, salt, 32), Buffer.from(expected, 'hex'));
  }
  // Upgrade existing shared-device PIN hashes after a successful check.
  let value = 5381;
  for (const digit of pin) value = ((value * 33) ^ digit.charCodeAt(0)) >>> 0;
  return value.toString(16) === hash;
}
module.exports = protect(async (context, req) => {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const memberId = req.membership.member_id;
  const familyId = req.membership.family_id;
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
  const result = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_profile_pin_attempt`, {
    method: 'POST', headers, timeout: 10000,
    body: JSON.stringify({ p_member_id: memberId, p_family_id: familyId, p_observed_hash: member.pin_hash, p_matches: matches, p_new_hash: newHash }),
  });
  if (!result.ok) throw Object.assign(new Error('Could not check your PIN. Please try again.'), { status: 503 });
  const outcome = await result.json();
  context.res = { status: outcome.status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(outcome) };
}, {});
