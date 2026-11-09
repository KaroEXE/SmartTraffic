const crypto = require('crypto');
const { sendError } = require('./apiError');

/**
 * Access tokens of signed-in users (POST /api/v1/auth/signup and /login).
 * Sent as "Authorization: Bearer <token>".
 *
 * Format: a JWT (RFC 7519) signed with HMAC-SHA256 (USER_TOKEN_SECRET).
 *   header  { alg: "HS256", typ: "JWT" }
 *   payload { iss: "smarttraffic", typ: "user", sub: <user id>,
 *             tv: <the account's tokenVersion>, iat, exp }
 * A token is only accepted while `tv` still equals the account's
 * tokenVersion (checked against the database by the auth controller), so
 * logout and password changes revoke every earlier token.
 * Only HS256 is accepted; the header's alg is checked, never trusted. The
 * `typ: "user"` claim keeps device tokens (utils/deviceToken.js) from being
 * accepted here even if both used the same secret.
 */

const ISSUER = 'smarttraffic';
const USER_ID_PATTERN = /^[a-f0-9]{24}$/;
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const CLOCK_SKEW_SECONDS = 60;

function decodeJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function createUserTokens({ secret = '', ttlSeconds = 7 * 86400, now = Date.now, log = console } = {}) {
  let key = secret;
  if (!key) {
    key = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    log.warn('[auth] USER_TOKEN_SECRET is not set: user tokens are signed with a per-process key and stop working at every restart. Set it (32+ characters) in production.');
  } else if (key.length < 32) {
    log.warn('[auth] USER_TOKEN_SECRET is shorter than 32 characters - use a long random value in production.');
  }

  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  const seconds = () => Math.floor(now() / 1000);

  function issue(userId, tokenVersion = 0) {
    const iat = seconds();
    const payload = {
      iss: ISSUER, typ: 'user', sub: String(userId), tv: tokenVersion, iat, exp: iat + ttlSeconds,
    };
    const body = `${HEADER}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return { token: `${body}.${sign(body)}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
  }

  /** { ok: true, userId, tokenVersion } or { ok: false, reason: 'invalid' | 'expired' }. */
  function verify(token) {
    if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'invalid' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'invalid' };
    const header = decodeJson(parts[0]);
    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') return { ok: false, reason: 'invalid' };
    const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
    const given = Buffer.from(parts[2]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
    const claims = decodeJson(parts[1]);
    if (!claims || claims.iss !== ISSUER || claims.typ !== 'user' || typeof claims.sub !== 'string' || !USER_ID_PATTERN.test(claims.sub)
      || !Number.isInteger(claims.tv) || claims.tv < 0 || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) {
      return { ok: false, reason: 'invalid' };
    }
    const t = seconds();
    if (claims.iat > t + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'invalid' };
    if (claims.exp <= t) return { ok: false, reason: 'expired' };
    return { ok: true, userId: claims.sub, tokenVersion: claims.tv };
  }

  return { issue, verify };
}

/** Middleware: 401 without a valid user token; sets req.userId and req.tokenVersion. */
function userAuth(tokens) {
  return (req, res, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
    if (!match) {
      res.set('WWW-Authenticate', 'Bearer realm="user"');
      return sendError(res, 401, 'USER_TOKEN_REQUIRED', 'Sign in first: POST /api/v1/auth/login');
    }
    const result = tokens.verify(match[1]);
    if (!result.ok) {
      res.set('WWW-Authenticate', 'Bearer realm="user", error="invalid_token"');
      return result.reason === 'expired'
        ? sendError(res, 401, 'USER_TOKEN_EXPIRED', 'The session has expired: sign in again with POST /api/v1/auth/login')
        : sendError(res, 401, 'USER_TOKEN_INVALID', 'The user token is not valid: sign in again with POST /api/v1/auth/login');
    }
    req.userId = result.userId;
    req.tokenVersion = result.tokenVersion;
    return next();
  };
}

module.exports = { createUserTokens, userAuth, USER_ID_PATTERN };
