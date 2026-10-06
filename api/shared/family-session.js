const fetch = require('node-fetch');
const crypto = require('node:crypto');
const cookieName = '__Host-trackline-family';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function sessionToken(req) {
  const match = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  const token = match && match.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function assertOrigin(req) {
  if (!req.headers.origin) return;
  let origin; try { origin = new URL(req.headers.origin); } catch { throw Object.assign(new Error('Invalid origin.'), { status: 403 }); }
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const configured = process.env.TRACKLINE_APP_ORIGIN;
  if (configured ? origin.origin !== configured : origin.host !== host) throw Object.assign(new Error('Invalid origin.'), { status: 403 });
}
async function service(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    timeout: 10000, ...options, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw Object.assign(new Error('Family sign-in is unavailable. Please try again.'), { status: response.status === 409 ? 409 : 503 });
  if (response.status === 204) return null;
  return response.json();
}
async function readSession(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const [session] = await service(`family_device_sessions?token_hash=eq.${digest(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*`);
  if (!session) throw Object.assign(new Error('Your family session has expired. Sign in again.'), { status: 401 });
  const [family] = await service(`families?id=eq.${encodeURIComponent(session.family_id)}&select=id,name,password_hash`);
  if (!family || family.password_hash !== session.password_version) throw Object.assign(new Error('The family password changed. Sign in again.'), { status: 401 });
  let memberships = [];
  if (session.member_id) {
    const [member] = await service(`members?id=eq.${encodeURIComponent(session.member_id)}&family_id=eq.${encodeURIComponent(session.family_id)}&select=id,role,pin_hash`);
    if (member && member.pin_hash && member.pin_hash === session.pin_version) memberships = [{ family_id: session.family_id, member_id: member.id, role: member.role }];
  }
  return { user: { id: `family:${session.family_id}`, email: null }, memberships, familySession: session, family };
}
const newToken = () => crypto.randomBytes(32).toString('hex');
const cookie = (token, clear = false) => `${cookieName}=${clear ? '' : token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : 2592000}`;
module.exports = { service, readSession, sessionToken, digest, cookie, newToken, assertOrigin };
