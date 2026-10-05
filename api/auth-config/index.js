function isPublicKey(key) {
  if (!key) return false;
  if (key.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; }
  catch { return false; }
}
module.exports = async function(context) {
  const url = process.env.SUPABASE_URL, publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const configured = url && isPublicKey(publishableKey);
  context.res = { status: configured ? 200 : 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(configured ? { url, publishableKey } : { error: 'Authentication is not configured.' }) };
};
