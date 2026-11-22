const crypto = require('crypto');
const { promisify } = require('util');

/**
 * Password hashing with scrypt (node:crypto, no dependency).
 *
 * Stored format: "scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>", so
 * the cost can be raised later without breaking existing hashes.
 */
const scrypt = promisify(crypto.scrypt);
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...COST, maxmem: MAX_MEMORY });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** True when `password` matches `stored`. Constant-time comparison. */
async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const expected = Buffer.from(parts[5], 'base64url');
  const key = await scrypt(password, Buffer.from(parts[4], 'base64url'), expected.length, { N, r, p, maxmem: MAX_MEMORY });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// Checked against when the email is unknown, so a login attempt takes the
// same time whether or not the account exists.
let dummyHash = null;
async function burnPasswordCheck(password) {
  dummyHash ||= await hashPassword(crypto.randomUUID());
  await verifyPassword(password, dummyHash);
  return false;
}

module.exports = { hashPassword, verifyPassword, burnPasswordCheck };
