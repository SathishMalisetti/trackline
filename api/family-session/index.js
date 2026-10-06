const { service, readSession, sessionToken, digest, cookie, newToken, assertOrigin } = require('../shared/family-session');
const { hashSecret, matchesSecret, legacyHash } = require('../shared/credentials');
const json = (status, body, headers = {}) => ({ status, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
module.exports = async (context, req) => {
  try {
    if (req.method !== 'GET') assertOrigin(req);
    if (req.method === 'DELETE') {
      const token = sessionToken(req);
      if (token) await service(`family_device_sessions?token_hash=eq.${digest(token)}`, { method: 'DELETE' });
      context.res = json(200, { ok: true }, { 'Set-Cookie': cookie('', true) }); return;
    }
    if ((req.body || {}).action === 'setup') {
      const auth = await readSession(req);
      if (!auth) throw Object.assign(new Error('Create or sign in to your family first.'), { status: 401 });
      const { parentName, members = [] } = req.body;
      if (typeof parentName !== 'string' || !parentName.trim() || parentName.trim().length > 80 || !Array.isArray(members) || members.length > 20
        || !members.every(member => member && typeof member.name === 'string' && member.name.trim().length >= 1 && member.name.trim().length <= 80 && ['parent', 'kid'].includes(member.role))) {
        throw Object.assign(new Error('Enter your name and valid names and roles for family members.'), { status: 400 });
      }
      const result = await service('rpc/setup_registered_family', { method: 'POST', body: JSON.stringify({ p_token_hash: auth.familySession.token_hash, p_parent_name: parentName.trim(), p_members: members.map(member => ({ name: member.name.trim(), role: member.role })) }) });
      context.res = json(result.status, result); return;
    }
    if (req.method === 'GET' || (req.body || {}).action === 'lock') {
      const auth = await readSession(req);
      if (!auth) { context.res = json(200, { signedIn: false }); return; }
      if (req.method === 'POST') await service(`family_device_sessions?token_hash=eq.${auth.familySession.token_hash}`, { method: 'PATCH', body: JSON.stringify({ member_id: null, pin_version: null }) });
      const members = await service(`members?family_id=eq.${encodeURIComponent(auth.family.id)}&select=id,name,role,pin_hash`);
      context.res = json(200, { signedIn: true, familyId: auth.family.id, familyName: auth.family.name,
        needsSetup: !!auth.familySession.bootstrap_member_id && !auth.familySession.setup_completed,
        members: members.map(member => ({ id: member.id, name: member.name, role: member.role, hasPin: !!member.pin_hash, canSetPin: true })) }); return;
    }
    const { action, identity, password, username, familyName, parentName } = req.body || {};
    if (typeof password !== 'string' || password.length < 1 || password.length > 128) throw Object.assign(new Error('Enter a family password.'), { status: 400 });
    const token = newToken();
    let result;
    if (action === 'register') {
      if (typeof username !== 'string' || !/^[a-z][a-z0-9_-]{2,31}$/i.test(username) || password.length < 8
        || typeof familyName !== 'string' || familyName.trim().length < 1 || familyName.trim().length > 80) {
        throw Object.assign(new Error('Enter a family name, username (3–32 letters, numbers, _ or -), and a password of at least 8 characters.'), { status: 400 });
      }
      result = await service('rpc/register_family_credentials', { method: 'POST', body: JSON.stringify({ p_username: username.toLowerCase(), p_family_name: familyName.trim(), p_parent_name: username, p_password_hash: await hashSecret(password), p_legacy_hash: legacyHash(password), p_token_hash: digest(token) }) });
    } else if (action === 'login') {
      if (typeof identity !== 'string' || !/^[a-z0-9_-]{3,64}$/i.test(identity)) throw Object.assign(new Error('Enter your family ID or username.'), { status: 400 });
      const rows = await service(`families?or=(id.eq.${identity.toUpperCase()},login_username.eq.${identity.toLowerCase()})&select=id,password_hash,login_password_hash,login_password_version`);
      const family = rows.length === 1 ? rows[0] : null;
      const currentHash = family && family.login_password_version === family.password_hash ? family.login_password_hash : null;
      const matches = !!family && await matchesSecret(password, currentHash || family.password_hash);
      if (!family) { await hashSecret(password); throw Object.assign(new Error('Incorrect family ID, username or password.'), { status: 403 }); }
      result = await service('rpc/check_family_login_attempt', { method: 'POST', body: JSON.stringify({ p_family_id: family.id, p_observed_hash: family.password_hash, p_matches: matches, p_secure_hash: matches && !currentHash ? await hashSecret(password) : null, p_token_hash: digest(token) }) });
    } else throw Object.assign(new Error('Unknown sign-in action.'), { status: 400 });
    context.res = json(result.status, result, result.status === 200 ? { 'Set-Cookie': cookie(token) } : {});
  } catch (error) { context.res = json(error.status || 503, { error: error.status === 409 ? 'That username is already in use. Choose another.' : error.status ? error.message : 'Family sign-in is unavailable. Please try again.' }); }
};
