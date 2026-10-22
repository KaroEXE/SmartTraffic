const crypto = require('crypto');
const { sendError } = require('./apiError');

/**
 * Anonymous device tokens for the mobile app.
 *
 * The public navigation app has no user accounts. Each app install asks for
 * a token once (POST /api/v1/auth/device) and sends it as
 * "Authorization: Bearer <token>" when it writes something (community
 * reports and votes). The token lets the backend rate-limit writes per
 * device, stop double votes and let a device withdraw its own reports. It
 * identifies an install, not a person, and proves nothing about who holds
 * it: anyone can obtain one, which is why registration is rate limited per
 * IP address.
 *
 * Format: a JWT (RFC 7519) signed with HMAC-SHA256 (DEVICE_TOKEN_SECRET).
 *   header  { alg: "HS256", typ: "JWT" }
 *   payload { iss: "smarttraffic", typ: "device", sub: <device id, UUID>,
 *             plt: <platform>, iat, exp }   (seconds since the epoch)
 * Only HS256 is accepted; the header's alg is checked, never trusted.
 */

const ISSUER = 'smarttraffic';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const CLOCK_SKEW_SECONDS = 60;
// Re-registering with a token closer than this to expiry returns a fresh token.
const RENEW_WITHIN_SECONDS = 7 * 86400;

function decodeJson(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function createDeviceTokens({ secret = '', ttlSeconds = 30 * 86400, now = Date.now, log = console } = {}) {
  let key = secret;
  const ephemeral = !key;
  if (ephemeral) {
    // Two UUIDs = 244 random bits. Valid until this process exits.
    key = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    log.warn('[navigation] DEVICE_TOKEN_SECRET is not set: device tokens are signed with a per-process key and stop working at every restart. Set it (32+ characters) in production.');
  } else if (key.length < 32) {
    log.warn('[navigation] DEVICE_TOKEN_SECRET is shorter than 32 characters - use a long random value in production.');
  }

  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  const seconds = () => Math.floor(now() / 1000);

  function issue({ deviceId = null, platform = 'other' } = {}) {
    const iat = seconds();
    const payload = {
      iss: ISSUER, typ: 'device', sub: deviceId || crypto.randomUUID(), plt: platform, iat, exp: iat + ttlSeconds,
    };
    const body = `${HEADER}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return {
      token: `${body}.${sign(body)}`,
      deviceId: payload.sub,
      platform,
      issuedAt: new Date(iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  /** { ok: true, device: { id, platform, expiresAt } } or { ok: false, reason: 'invalid' | 'expired' }. */
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
    if (!claims || claims.iss !== ISSUER || claims.typ !== 'device' || typeof claims.sub !== 'string' || !UUID_PATTERN.test(claims.sub)
      || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) {
      return { ok: false, reason: 'invalid' };
    }
    const t = seconds();
    if (claims.iat > t + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'invalid' };
    if (claims.exp <= t) return { ok: false, reason: 'expired' };
    return {
      ok: true,
      device: { id: claims.sub, platform: claims.plt || 'other', expiresAt: new Date(claims.exp * 1000).toISOString(), exp: claims.exp },
    };
  }

  /** True when a still-valid token should be replaced by a fresh one. */
  const shouldRenew = (device) => device.exp - seconds() < RENEW_WITHIN_SECONDS;

  return { issue, verify, shouldRenew, ephemeral };
}

function bearer(req) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
  return match ? match[1] : null;
}

/**
 * Middleware. required=true: 401 without a valid token. required=false:
 * a valid token sets req.device, a missing one is fine, and an invalid one
 * is still refused (so the app notices and re-registers).
 */
function deviceAuth(tokens, { required }) {
  return (req, res, next) => {
    const token = bearer(req);
    if (!token) {
      if (!required) return next();
      res.set('WWW-Authenticate', 'Bearer realm="device"');
      return sendError(res, 401, 'DEVICE_TOKEN_REQUIRED', 'This request needs a device token: POST /api/v1/auth/device');
    }
    const result = tokens.verify(token);
    if (!result.ok) {
      res.set('WWW-Authenticate', 'Bearer realm="device", error="invalid_token"');
      return result.reason === 'expired'
        ? sendError(res, 401, 'DEVICE_TOKEN_EXPIRED', 'The device token has expired: register again with POST /api/v1/auth/device')
        : sendError(res, 401, 'DEVICE_TOKEN_INVALID', 'The device token is not valid: register again with POST /api/v1/auth/device');
    }
    req.device = result.device;
    return next();
  };
}

module.exports = { createDeviceTokens, deviceAuth, UUID_PATTERN };
