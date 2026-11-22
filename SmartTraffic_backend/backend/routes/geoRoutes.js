const express = require('express');
const { createRateLimiter } = require('../utils/rateLimit');
const { handle, sendError } = require('../utils/apiError');

/**
 * Redoz's own search and reverse geocoding, mounted at /api (before the traffic routes):
 *   GET /api/search
 *   GET /api/geocode/reverse
 * Public, like /api/v1/places/*: no token. Limited per client IP (RATE_LIMIT_SEARCH_PER_MINUTE).
 * Documented in docs/openapiNavigation.js (checked by test/geoApi.test.js).
 */
function createGeoRoutes({ controller, rateLimits, now = Date.now }) {
  const router = express.Router();
  const limited = createRateLimiter({
    name: 'place search', windowMs: 60_000, max: rateLimits.searchPerMinute, now,
  });

  router.get('/search', limited, handle(controller.search));
  router.get('/geocode/reverse', limited, handle(controller.reverse));
  // Only these two paths belong to this router; anything else under /api falls through.
  router.all(['/search', '/geocode/reverse'], (req, res) => sendError(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} is not allowed here`));
  return router;
}

module.exports = { createGeoRoutes };
