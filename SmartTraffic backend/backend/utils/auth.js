const crypto = require('crypto');

/**
 * Shared-secret ("Bearer token") checks for server-to-server requests.
 *
 *   TRAFFIC_INGEST_TOKEN  the Python AI service: POST /api/traffic,
 *                         GET /api/streams, POST /api/streams/health
 *   STREAM_ADMIN_TOKEN    whoever manages camera streams: create / update /
 *                         delete stream records
 *
 * Tokens are compared in constant time and never logged or echoed back.
 */

const digest = (value) => crypto.createHash('sha256').update(value).digest();

/** The token from "Authorization: Bearer <token>", or null. */
function bearerToken(req) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
  return match ? match[1] : null;
}

/** True when the request carries one of `expected` (empty values are ignored). */
function hasBearerToken(req, expected) {
  const given = bearerToken(req);
  if (!given) return false;
  const a = digest(given);
  // Check every candidate so the time taken does not reveal which one matched.
  return [].concat(expected).filter(Boolean)
    .reduce((ok, token) => crypto.timingSafeEqual(a, digest(token)) || ok, false);
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer');
  return res.status(401).json({ ok: false, error: 'Missing or invalid token' });
}

/**
 * Express middleware.
 *   tokens         accepted tokens; empty values are ignored
 *   openWhenUnset  true: no configured token = no check (development, same
 *                  rule as POST /api/traffic). false: no configured token =
 *                  the route is disabled (503) with `disabledMessage`.
 */
function requireToken(tokens, { openWhenUnset, disabledMessage = 'This endpoint is disabled' }) {
  const configured = [].concat(tokens).filter(Boolean);
  return (req, res, next) => {
    if (!configured.length) {
      if (openWhenUnset) return next();
      return res.status(503).json({ ok: false, error: disabledMessage });
    }
    if (!hasBearerToken(req, configured)) return unauthorized(res);
    return next();
  };
}

module.exports = { bearerToken, hasBearerToken, requireToken, unauthorized };
