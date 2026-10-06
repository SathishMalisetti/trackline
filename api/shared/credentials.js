const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
function legacyHash(value) {
  let hash = 5381;
  for (let i=0;i<value.length;i++) hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  return hash.toString(16);
}
async function hashSecret(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await scrypt(value, salt, 32)).toString('hex')}`;
}
async function matchesSecret(value, hash) {
  if (!hash) return false;
  if (!hash.startsWith('scrypt:')) return legacyHash(value) === hash;
  const [, salt, expected] = hash.split(':');
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(expected || '')) return false;
  return crypto.timingSafeEqual(await scrypt(value, salt, 32), Buffer.from(expected, 'hex'));
}
module.exports = { hashSecret, matchesSecret, legacyHash };
