const fetch = require('node-fetch');

function response(status, error) {
  return { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error }) };
}

async function authenticate(req) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !serviceKey) throw Object.assign(new Error('Authentication is not configured.'), { status: 503 });
  // Static Web Apps replaces Authorization with its own platform token.
  // Prefer the client token in a separate header; still validate it with Supabase.
  const headers = req.headers || {};
  const authorization = headers['x-trackline-authorization'] || headers['X-Trackline-Authorization']
    || headers.authorization || headers.Authorization;
  if (!authorization || !/^Bearer \S+$/i.test(authorization)) throw Object.assign(new Error('Sign in required.'), { status: 401 });
  // Validate with Auth on every request; never trust decoded JWTs or browser state.
  const result = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: authorization }, timeout: 10000 });
  if (!result.ok) throw Object.assign(new Error('Your session has expired. Sign in again.'), { status: result.status >= 500 ? 503 : 401 });
  const user = await result.json();
  if (!user.id || !user.email || user.is_anonymous) throw Object.assign(new Error('An email account is required.'), { status: 403 });
  // Email confirmation can be enabled at launch independently of password sign-in.
  if (process.env.REQUIRE_EMAIL_VERIFICATION === 'true' && !user.email_confirmed_at) {
    throw Object.assign(new Error('Confirm your email before continuing.'), { status: 403 });
  }
  const memberships = await fetch(`${url}/rest/v1/family_auth_memberships?user_id=eq.${encodeURIComponent(user.id)}&select=family_id,member_id,role`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, timeout: 10000,
  });
  if (!memberships.ok) throw Object.assign(new Error('Could not verify family access.'), { status: 503 });
  return { user, memberships: await memberships.json() };
}

function protect(handler, options = {}) {
  return async (context, req) => {
    try {
      // Existing machine credential paths remain scoped to their own device.
      if (options.device && req.body && req.body.deviceToken) return await handler(context, req);
      const auth = await authenticate(req);
      req.auth = auth;
      const body = req.body || {}, query = req.query || {};
      if (body.familyId && query.familyId && body.familyId !== query.familyId) {
        throw Object.assign(new Error('Conflicting family IDs.'), { status: 400 });
      }
      for (const field of ['kidId', 'memberId', 'choreId']) {
        if (body[field] && query[field] && body[field] !== query[field]) {
          throw Object.assign(new Error('Conflicting profile or task IDs.'), { status: 400 });
        }
      }
      const profileIds = [body.kidId, query.kidId, body.memberId, query.memberId].filter(Boolean);
      if (new Set(profileIds).size > 1) throw Object.assign(new Error('Conflicting profile IDs.'), { status: 400 });
      const familyId = body.familyId || query.familyId;
      if (!options.global) {
        const membership = auth.memberships.find(m => m.family_id === familyId);
        if (!membership) throw Object.assign(new Error('You do not have access to this family.'), { status: 403 });
        req.membership = membership;
        if ((options.parent || (options.parentWrite && req.method !== 'GET')) && membership.role !== 'parent') {
          throw Object.assign(new Error('Parent access required.'), { status: 403 });
        }
        const memberId = body.kidId || query.kidId || body.memberId || query.memberId;
        if (body.data && body.data.family && body.data.family.id !== familyId) {
          throw Object.assign(new Error('Family data does not match the requested family.'), { status: 400 });
        }
        if (membership.role === 'kid' && memberId && membership.member_id !== memberId) {
          throw Object.assign(new Error('You can only access your own profile.'), { status: 403 });
        }
        if (memberId && membership.role === 'parent') {
          const memberResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/members?id=eq.${encodeURIComponent(memberId)}&family_id=eq.${encodeURIComponent(familyId)}&select=id`, {
            headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }, timeout: 10000,
          });
          if (!memberResponse.ok) throw Object.assign(new Error('Could not verify profile ownership.'), { status: 503 });
          if (!(await memberResponse.json()).length) throw Object.assign(new Error('Profile does not belong to this family.'), { status: 403 });
        }
        if (options.chore && membership.role === 'kid') {
          const choreId = body.choreId || query.choreId;
          const chores = await fetch(`${process.env.SUPABASE_URL}/rest/v1/chores?id=eq.${encodeURIComponent(choreId || '')}&family_id=eq.${encodeURIComponent(familyId)}&member_id=eq.${encodeURIComponent(membership.member_id)}&select=id`, {
            headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }, timeout: 10000,
          });
          if (!chores.ok) throw Object.assign(new Error('Could not verify task ownership.'), { status: 503 });
          if (!(await chores.json()).length) throw Object.assign(new Error('You can only complete your own tasks.'), { status: 403 });
          if (req.method === 'POST') req.body.loggedBy = membership.member_id;
        }
      }
      await handler(context, req);
      if (options.sanitize && req.membership.role === 'kid' && context.res && context.res.status === 200) {
        const data = JSON.parse(context.res.body);
        if (data) {
          if (data.family) delete data.family.passwordHash;
          if (data.members) data.members.forEach(m => { delete m.pinHash; });
          if (data.topicProgress) data.topicProgress = data.topicProgress.filter(p => p.kidId === req.membership.member_id);
          for (const key of ['usage', 'devices', 'categoryUsage']) {
            if (Array.isArray(data[key])) data[key] = data[key].filter(row => row.memberId === req.membership.member_id);
          }
          context.res.body = JSON.stringify(data);
        }
      }
      if (context.res) context.res.headers = { ...context.res.headers, 'Cache-Control': 'no-store' };
    } catch (error) {
      context.res = response(error.status || 503, error.status ? error.message : 'Authentication service unavailable.');
    }
  };
}

module.exports = { authenticate, protect, response };
