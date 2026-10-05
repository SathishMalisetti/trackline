const { protect } = require('../shared/auth');
module.exports = protect(async function(context, req) {
  context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: req.auth.user.email, memberships: req.auth.memberships }) };
}, { global: true });
