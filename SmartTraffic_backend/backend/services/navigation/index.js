const { isDatabaseConnected } = require('../../config/database');
const { createDeviceTokens } = require('../../utils/deviceToken');
const { createUserTokens } = require('../../utils/userToken');
const { createUserAccountService } = require('./userAccountService');
const { createAuthController } = require('../../controllers/authController');
const { createAdminController } = require('../../controllers/adminController');
const { createGeoapifyClient, createOsrmClient } = require('./providerClient');
const { createPlaceService } = require('./placeService');
const { createRoutingService } = require('./routingService');
const { createLiveTrafficService } = require('./liveTrafficService');
const { createRoadFeatureService } = require('./roadFeatureService');
const { createLocalPlaceService } = require('./localPlaceService');
const { createSavedPlaceService } = require('./savedPlaceService');
const { createPlaceDataController } = require('../../controllers/placeDataController');
const { createRoadReportService } = require('./roadReportService');
const { createRoutePlanner } = require('./routePlanner');
const { createNavigationController } = require('../../controllers/navigationController');
const { createRoadDataController } = require('../../controllers/roadDataController');
const { createNavigationRoutes } = require('../../routes/navigationRoutes');

/**
 * Builds the mobile navigation API (/api/v1): services, controllers and
 * router. server.js passes the live decision engine and the geographic
 * service (services/geo: place search, reverse geocoding, nearby - PostGIS);
 * tests pass fakes for the routing providers (fetchImpl), the geographic
 * service and the database models.
 *
 * Reads only from the live channel: `engine` must be the live
 * trafficDecisionService, never the simulation engine.
 */
function createNavigationApi({
  config,
  engine,
  geo,
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
  const userTokens = createUserTokens({
    secret: nav.userTokenSecret, ttlSeconds: nav.userTokenTtlSeconds, now, log,
  });
  const savedPlaces = createSavedPlaceService({ SavedPlace: models.SavedPlace, isConnected });
  const localPlaces = createLocalPlaceService({ LocalPlace: models.LocalPlace, isConnected });
  const userAccounts = createUserAccountService({ User: models.User, isConnected, afterDelete: (id) => savedPlaces.removeAllFor(id) });
  const geoapify = createGeoapifyClient({ config: nav.geoapify, ...common, log });
  const osrm = createOsrmClient({ config: nav.routing, ...common, log });
  // Search, reverse geocoding and nearby places: Redoz's own PostGIS database (services/geo).
  const places = createPlaceService({ geo, localPlaces });
  const routing = createRoutingService({
    geoapify, osrm, config: nav.routing, now, log,
  });
  const liveTraffic = createLiveTrafficService({ engine, config: nav.traffic, now });
  const roadFeatures = createRoadFeatureService({ RoadFeature: models.RoadFeature, isConnected, now });
  const roadReports = createRoadReportService({
    RoadReport: models.RoadReport, isConnected, config: nav.reports, now,
  });
  const routePlanner = createRoutePlanner({
    routing, liveTraffic, roadFeatures, roadReports, config: nav, now, log,
  });

  const navigationController = createNavigationController({
    config, deviceTokens, places, routing, routePlanner, liveTraffic, roadFeatures, roadReports, providers: { geoapify, osrm }, now,
  });
  const roadDataController = createRoadDataController({ roadFeatures, roadReports, log });
  const authController = createAuthController({ userAccounts, userTokens });
  const adminController = createAdminController({
    userAccounts, roadReports, roadFeatures, localPlaces, liveTraffic, health: navigationController.health, now,
  });
  const placeDataController = createPlaceDataController({ localPlaces, savedPlaces, userAccounts });
  const router = createNavigationRoutes({
    navigationController, roadDataController, authController, adminController, placeDataController, deviceTokens, userTokens, adminToken: nav.adminToken, rateLimits: nav.rateLimits, now,
  });

  return {
    router,
    health: navigationController.health,
    publicHealth: navigationController.publicHealth,
    services: {
      deviceTokens, userTokens, userAccounts, geoapify, osrm, places, routing, liveTraffic, roadFeatures, localPlaces, savedPlaces, roadReports, routePlanner,
    },
  };
}

/** Startup warnings for settings that are fine locally but not in production. */
function navigationWarnings(nav) {
  const warnings = [];
  if (!nav.geoapify.apiKey && !nav.routing.osrmUrl) {
    warnings.push('Neither GEOAPIFY_API_KEY nor ROUTING_OSRM_URL is set: routing is disabled.');
  }
  if (!nav.routing.osrmUrl && nav.geoapify.apiKey) warnings.push('Routing uses Geoapify: free-flow times, up to three routes. Set ROUTING_OSRM_URL for your own OSRM server.');
  if (!nav.adminToken) warnings.push('NAV_ADMIN_TOKEN is not set: road-feature management and report moderation are disabled.');
  return warnings;
}

module.exports = { createNavigationApi, navigationWarnings };
