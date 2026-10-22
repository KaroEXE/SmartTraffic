const { isDatabaseConnected } = require('../../config/database');
const { createDeviceTokens } = require('../../utils/deviceToken');
const { createGeocodingService } = require('./geocodingService');
const { createOverpassService } = require('./overpassService');
const { createRoutingService } = require('./routingService');
const { createLiveTrafficService } = require('./liveTrafficService');
const { createRoadFeatureService } = require('./roadFeatureService');
const { createRoadReportService } = require('./roadReportService');
const { createRoutePlanner } = require('./routePlanner');
const { createNavigationController } = require('../../controllers/navigationController');
const { createRoadDataController } = require('../../controllers/roadDataController');
const { createNavigationRoutes } = require('../../routes/navigationRoutes');

/**
 * Builds the mobile navigation API (/api/v1): services, controllers and
 * router. server.js passes the live decision engine; tests pass fakes for
 * the providers (fetchImpl) and the database models.
 *
 * Reads only from the live channel: `engine` must be the live
 * trafficDecisionService, never the simulation engine.
 */
function createNavigationApi({
  config,
  engine,
  fetchImpl = globalThis.fetch,
  isConnected = isDatabaseConnected,
  models = {},
  now = Date.now,
  log = console,
}) {
  const nav = config.navigation;
  const common = {
    userAgent: nav.userAgent, maxWaitMs: nav.providerMaxWaitMs, cooldownMs: nav.providerCooldownMs, fetchImpl, now,
  };
  const deviceTokens = createDeviceTokens({
    secret: nav.deviceTokenSecret, ttlSeconds: nav.deviceTokenTtlSeconds, now, log,
  });
  const geocoding = createGeocodingService({ config: { ...nav.geocoding, contactEmail: nav.contactEmail }, ...common });
  const overpass = createOverpassService({ config: nav.overpass, ...common });
  const routing = createRoutingService({ config: nav.routing, ...common, log });
  const liveTraffic = createLiveTrafficService({ engine, config: nav.traffic, now });
  const roadFeatures = createRoadFeatureService({ RoadFeature: models.RoadFeature, isConnected, now });
  const roadReports = createRoadReportService({
    RoadReport: models.RoadReport, isConnected, config: nav.reports, now,
  });
  const routePlanner = createRoutePlanner({
    routing, liveTraffic, roadFeatures, roadReports, config: nav, now, log,
  });

  const navigationController = createNavigationController({
    config, deviceTokens, geocoding, overpass, routing, routePlanner, liveTraffic, roadFeatures, roadReports, now,
  });
  const roadDataController = createRoadDataController({
    roadFeatures, roadReports, overpass, log,
  });
  const router = createNavigationRoutes({
    navigationController, roadDataController, deviceTokens, adminToken: nav.adminToken, rateLimits: nav.rateLimits, now,
  });

  return {
    router,
    health: navigationController.health,
    services: {
      deviceTokens, geocoding, overpass, routing, liveTraffic, roadFeatures, roadReports, routePlanner,
    },
  };
}

/** Startup warnings for settings that are fine locally but not in production. */
function navigationWarnings(nav) {
  const warnings = [];
  const host = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
  if (nav.routing.url && host(nav.routing.url) === 'router.project-osrm.org') {
    warnings.push('Routing uses the public OSRM demo server (no SLA, ~1 request/s for this whole server). Set ROUTING_URL to a self-hosted OSRM for production.');
  }
  if (nav.geocoding.url && host(nav.geocoding.url) === 'nominatim.openstreetmap.org') {
    warnings.push('Place search uses the public Nominatim server (max 1 request/s, no heavy use). Set GEOCODING_URL to a self-hosted or commercial Nominatim-compatible service for production.');
  }
  if (!nav.contactEmail && (nav.geocoding.url || nav.overpass.urls.length)) {
    warnings.push('PROVIDER_CONTACT_EMAIL is not set: the OpenStreetMap services ask for a contact address in the User-Agent.');
  }
  if (!nav.adminToken) warnings.push('NAV_ADMIN_TOKEN is not set: road-feature management and report moderation are disabled.');
  return warnings;
}

module.exports = { createNavigationApi, navigationWarnings };
