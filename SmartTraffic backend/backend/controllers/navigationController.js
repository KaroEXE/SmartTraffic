const {
  parseBBox, parseLanguage, parseQueryPoint, validateRouteRequest, validateDeviceRegistration,
  validateNearbyQuery, validateSearchQuery,
} = require('../utils/navValidation');
const { invalid, sendError } = require('../utils/apiError');
const {
  FEATURE_KINDS, REPORT_TYPES, PLACE_CATEGORIES, LIMITS,
} = require('../models/navigationConstants');

/**
 * HTTP layer of the mobile navigation API (/api/v1): app configuration,
 * device registration, places, routes and live traffic. Road features and
 * community reports are in roadDataController.js; routes and middleware
 * (authentication, rate limits) in routes/navigationRoutes.js.
 *
 * Every success answer is { ok: true, ... }; every error is
 * { ok: false, code, error, details? } (utils/apiError.js).
 */

// Search, places and routing come from Geoapify, whose free plan requires "Powered by Geoapify"
// and the OpenStreetMap attribution wherever those results are shown.
const ATTRIBUTION = {
  text: '© OpenStreetMap contributors. Powered by Geoapify',
  url: 'https://www.openstreetmap.org/copyright',
  provider: 'Geoapify',
  providerUrl: 'https://www.geoapify.com/',
};
// The map: OpenFreeMap's terms ask for this; MapLibre adds it by itself from the style.
const MAP_ATTRIBUTION = {
  text: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
  url: 'https://openfreemap.org',
  provider: 'OpenFreeMap',
};

function unwrap(parsed) {
  if (parsed.errors) throw invalid(parsed.errors[0], parsed.errors);
  return parsed.value;
}

function createNavigationController({
  config, deviceTokens, places, routing, routePlanner, liveTraffic, roadFeatures, roadReports, providers, now = Date.now,
}) {
  const nav = config.navigation;

  /** Bounding box and centre of the monitored intersections (where live AI traffic exists). */
  function liveTrafficArea() {
    const points = liveTraffic.views().filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lng));
    if (!points.length) return null;
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    return {
      center: { lat: lats.reduce((s, x) => s + x, 0) / lats.length, lng: lngs.reduce((s, x) => s + x, 0) / lngs.length },
      bbox: {
        south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs),
      },
      surveyed: points.filter((p) => p.positionSource === 'surveyed').length,
      placeholders: points.filter((p) => p.positionSource === 'placeholder').length,
    };
  }

  return {
    /** GET /api/v1/config - what this server offers, its limits and required attribution. */
    config(req, res) {
      const dbReady = roadReports.available();
      res.set('Cache-Control', 'no-cache');
      res.json({
        ok: true,
        apiVersion: '1',
        serverTime: new Date(now()).toISOString(),
        features: {
          map: { provider: 'openfreemap', ...nav.map },
          placeSearch: { available: places.enabled, provider: places.enabled ? 'geoapify' : null },
          placesNearby: { available: places.enabled, categories: Object.keys(PLACE_CATEGORIES) },
          routing: {
            available: routing.enabled, provider: routing.status().provider, profile: 'driving', maxRoutes: nav.routing.maxRoutes,
          },
          liveTraffic: {
            available: true,
            monitoredIntersections: liveTraffic.count(),
            staleAfterSeconds: nav.traffic.staleAfterSeconds,
            recommendedRefreshSeconds: 15,
            area: liveTrafficArea(),
          },
          roadFeatures: {
            kinds: FEATURE_KINDS,
            operator: { available: dbReady },
            osm: { available: false, kinds: [] }, // OpenStreetMap features were retired; kept so older apps do not break
          },
          reports: {
            available: dbReady,
            types: REPORT_TYPES,
            requiresDeviceToken: true,
            ttlMinutes: nav.reports.ttlMinutes,
          },
        },
        limits: {
          searchMinLength: LIMITS.searchMinLength,
          searchMaxLength: LIMITS.searchMaxLength,
          searchMaxResults: LIMITS.searchMaxResults,
          nearbyMaxRadiusMeters: LIMITS.nearbyMaxRadiusMeters,
          maxBBoxSpanDeg: LIMITS.maxBBoxSpanDeg,
          reportDescriptionMaxLength: LIMITS.reportDescriptionLength,
          rateLimits: nav.rateLimits,
        },
        attribution: [
          { ...MAP_ATTRIBUTION, requiredFor: ['map'] },
          { ...ATTRIBUTION, requiredFor: ['placeSearch', 'placesNearby', 'routing'] },
        ],
      });
    },

    /**
     * POST /api/v1/auth/device - a new device token, or (with a valid token
     * in Authorization) a fresh token for the same device when the current
     * one is within 7 days of expiry.
     */
    registerDevice(req, res) {
      // The body is optional; express.json() leaves {} when there is none.
      const input = unwrap(validateDeviceRegistration(req.body && Object.keys(req.body).length ? req.body : undefined));
      if (req.device && !deviceTokens.shouldRenew(req.device)) {
        return res.json({
          ok: true, renewed: false, deviceId: req.device.id, expiresAt: req.device.expiresAt, tokenType: 'Bearer',
        });
      }
      const issued = deviceTokens.issue({ deviceId: req.device ? req.device.id : null, platform: input.platform });
      return res.status(req.device ? 200 : 201).json({
        ok: true,
        renewed: Boolean(req.device),
        tokenType: 'Bearer',
        token: issued.token,
        deviceId: issued.deviceId,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
      });
    },

    /** GET /api/v1/places/search?q=&lat=&lng=&limit=&lang= */
    async searchPlaces(req, res) {
      const { q, near, limit } = unwrap(validateSearchQuery(req.query));
      const lang = unwrap(parseLanguage(req));
      const result = await places.search({
        q, near, limit, lang,
      });
      res.json({
        ok: true, query: q, scope: result.scope, count: result.places.length, places: result.places, cached: result.cached, attribution: ATTRIBUTION,
      });
    },

    /** GET /api/v1/places/reverse?lat=&lng=&lang= */
    async reversePlace(req, res) {
      const point = unwrap(parseQueryPoint(req.query));
      const lang = unwrap(parseLanguage(req));
      const result = await places.reverse({ ...point, lang });
      res.json({
        ok: true, place: result.place, cached: result.cached, attribution: ATTRIBUTION,
      });
    },

    /** GET /api/v1/places/nearby?lat=&lng=&category=&radius=&limit= */
    async nearbyPlaces(req, res) {
      const query = unwrap(validateNearbyQuery(req.query));
      const lang = unwrap(parseLanguage(req));
      const result = await places.nearby({ ...query, lang });
      res.json({
        ok: true,
        category: query.category,
        center: { lat: query.lat, lng: query.lng },
        radius: query.radius,
        count: result.places.length,
        places: result.places,
        cached: result.cached,
        attribution: ATTRIBUTION,
      });
    },

    /** POST /api/v1/routes { start, destination, maxRoutes?, steps? } */
    async planRoutes(req, res) {
      if (!req.is('application/json')) return sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
      const input = unwrap(validateRouteRequest(req.body, { maxRoutes: nav.routing.maxRoutes }));
      const plan = await routePlanner.plan(input);
      return res.json({ ok: true, ...plan, attribution: ATTRIBUTION });
    },

    /** GET /api/v1/traffic[?south=&west=&north=&east=] */
    traffic(req, res) {
      const bbox = unwrap(parseBBox(req.query, { required: false, maxSpanDeg: 5 }));
      const list = liveTraffic.list({ bbox });
      res.set('Cache-Control', 'no-cache');
      res.json({ ok: true, ...list, count: list.intersections.length });
    },

    /** Health block for GET /api/health: no budget, error text or key type (those are in the admin overview). */
    publicHealth() {
      const g = providers.geoapify.status();
      return {
        geoapify: { enabled: g.enabled, circuit: g.circuit },
        routing: { enabled: routing.enabled },
        places: { enabled: places.enabled },
        database: roadReports.available() ? 'connected' : 'unavailable',
      };
    },

    /** Full health for the admin overview (GET /api/v1/admin/overview). */
    health() {
      return {
        geoapify: providers.geoapify.status(),
        osrm: providers.osrm.status(),
        routing: routing.status(),
        places: places.status(),
        database: roadReports.available() ? 'connected' : 'unavailable',
        deviceTokens: deviceTokens.ephemeral ? 'ephemeral-secret' : 'configured',
        adminEndpoints: nav.adminToken ? 'enabled' : 'disabled',
      };
    },
  };
}

module.exports = { createNavigationController, ATTRIBUTION, MAP_ATTRIBUTION };
