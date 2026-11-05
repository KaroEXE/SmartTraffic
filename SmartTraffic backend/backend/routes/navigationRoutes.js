const express = require('express');
const { hasBearerToken } = require('../utils/auth');
const { deviceAuth } = require('../utils/deviceToken');
const { createRateLimiter } = require('../utils/rateLimit');
const { handle, sendError } = require('../utils/apiError');

/**
 * Mobile navigation API, mounted at /api/v1. See docs/API_REFERENCE.md and
 * docs/MOBILE_INTEGRATION_GUIDE.md; Swagger documents every route here
 * (docs/openapiNavigation.js, checked by test/navigationApi.test.js).
 *
 * Access
 *   public   no token
 *   device   "Authorization: Bearer <device token>" from POST /auth/device
 *   admin    "Authorization: Bearer <NAV_ADMIN_TOKEN>" - operator tools only,
 *            never in the app; disabled (503) when NAV_ADMIN_TOKEN is not set
 *
 * Rate limits (config.navigation.rateLimits): every route per IP, plus a
 * tighter per-IP limit on the routes that call external providers and
 * per-device limits on writes.
 */
function createNavigationRoutes({
  navigationController: nav, roadDataController: road, deviceTokens, adminToken, rateLimits, now = Date.now,
}) {
  const router = express.Router();
  const minute = 60_000;
  const hour = 3_600_000;
  const limit = (name, windowMs, max, key) => createRateLimiter({
    name, windowMs, max, key, now,
  });
  const perDevice = (req) => (req.device ? req.device.id : null);

  const general = limit('API', minute, rateLimits.perMinute);
  const search = limit('place search', minute, rateLimits.searchPerMinute);
  const places = limit('nearby place', minute, rateLimits.placesPerMinute);
  const routes = limit('route', minute, rateLimits.routesPerMinute);
  const registrations = limit('device registration', hour, rateLimits.deviceRegistrationsPerHour);
  const reports = limit('report', hour, rateLimits.reportsPerHour, perDevice);
  const votes = limit('vote', hour, rateLimits.votesPerHour, perDevice);

  const device = deviceAuth(deviceTokens, { required: true });
  const optionalDevice = deviceAuth(deviceTokens, { required: false });
  const admin = (req, res, next) => {
    if (!adminToken) return sendError(res, 503, 'FEATURE_DISABLED', 'Administration is disabled: set NAV_ADMIN_TOKEN on the backend');
    if (!hasBearerToken(req, adminToken)) {
      res.set('WWW-Authenticate', 'Bearer realm="admin"');
      return sendError(res, 401, 'ADMIN_TOKEN_INVALID', 'Missing or invalid admin token');
    }
    return next();
  };

  router.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(general);

  router.get('/config', handle(nav.config));
  router.post('/auth/device', registrations, optionalDevice, handle(nav.registerDevice));

  router.get('/places/search', search, handle(nav.searchPlaces));
  router.get('/places/reverse', search, handle(nav.reversePlace));
  router.get('/places/nearby', places, handle(nav.nearbyPlaces));

  router.post('/routes', routes, handle(nav.planRoutes));
  router.get('/traffic', handle(nav.traffic));

  router.get('/road-features', handle(road.listFeatures));
  router.get('/road-features/:id', handle(road.getFeature));
  router.post('/road-features', admin, handle(road.createFeature));
  router.patch('/road-features/:id', admin, handle(road.updateFeature));
  router.delete('/road-features/:id', admin, handle(road.deleteFeature));

  router.get('/reports', optionalDevice, handle(road.listReports));
  router.get('/reports/:id', optionalDevice, handle(road.getReport));
  router.post('/reports', device, reports, handle(road.createReport));
  router.post('/reports/:id/votes', device, votes, handle(road.voteReport));
  router.delete('/reports/:id', device, handle(road.withdrawReport));
  router.patch('/reports/:id', admin, handle(road.moderateReport));

  router.use((req, res) => sendError(res, 404, 'NOT_FOUND', `No route ${req.method} ${req.originalUrl}`));
  return router;
}

module.exports = { createNavigationRoutes };
