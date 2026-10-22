const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[config] ${name}="${raw}" is not a number, using ${fallback}`);
    return fallback;
  }
  return value;
}

function httpUrl(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch { /* reported below */ }
  console.warn(`[config] ${name} is not a valid http(s) URL - ignored`);
  return '';
}

/**
 * Base URL of the Python/Flask AI service, without a trailing slash. The
 * browser loads <base>/video/<direction> and <base>/api/cameras from it.
 * An older single-stream value such as https://ai.example/video/north is
 * reduced to its base. User info, query and fragment are dropped: the value
 * is sent to browsers.
 */
function aiServiceBaseUrl(name) {
  const raw = httpUrl(name);
  if (!raw) return '';
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/(?:video\/[^/]*|video_feed)\/?$/, '').replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

function flag(name, fallback) {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * External navigation provider URL: blank = the public default, "off" =
 * provider disabled (its endpoints answer 503). Returned without a trailing
 * slash; null when disabled or invalid.
 */
function providerUrl(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (raw.toLowerCase() === 'off') return null;
  if (!raw) return fallback;
  const value = httpUrl(name);
  return value ? value.replace(/\/+$/, '') : null;
}

/** Hosts whose usage policy allows about one request per second. */
const PUBLIC_PROVIDER_HOSTS = new Set([
  'router.project-osrm.org', 'nominatim.openstreetmap.org',
  'overpass-api.de', 'overpass.private.coffee', 'overpass.kumi.systems',
]);
const isPublicProvider = (url) => {
  try { return PUBLIC_PROVIDER_HOSTS.has(new URL(url).hostname); } catch { return false; }
};
/** Minimum spacing between upstream requests: explicit, else 1.1 s for public hosts, 0 for self-hosted. */
function providerInterval(name, urls) {
  const list = [].concat(urls).filter(Boolean);
  return Math.max(0, num(name, list.some(isPublicProvider) ? 1100 : 0));
}

/** Express "trust proxy": blank = off, true/false, a hop count, or an address list. */
function trustProxy(raw) {
  const value = (raw || '').trim();
  if (!value || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

const PACKAGE_VERSION = require('../package.json').version;
const routingUrl = providerUrl('ROUTING_URL', 'https://router.project-osrm.org');
const geocodingUrl = providerUrl('GEOCODING_URL', 'https://nominatim.openstreetmap.org');
const overpassUrls = (process.env.OVERPASS_URLS || '').trim().toLowerCase() === 'off'
  ? []
  : ((process.env.OVERPASS_URLS || '').trim()
    ? process.env.OVERPASS_URLS.split(',').map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u)).map((u) => u.replace(/\/+$/, ''))
    : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']);
const contactEmail = (process.env.PROVIDER_CONTACT_EMAIL || '').trim();

const config = {
  port: num('PORT', 3000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // Historical data store. Never log this value: it may contain credentials.
  mongodbUri: (process.env.MONGODB_URI || '').trim(),
  // Python/Flask AI service whose four camera streams the Live AI page shows,
  // e.g. https://<ai-service>.onrender.com. Sent to browsers, so never put
  // credentials in it. Empty = the page shows "not connected".
  aiStreamUrl: aiServiceBaseUrl('AI_STREAM_URL'),
  // Shared secret the AI service sends as "Authorization: Bearer <token>" on
  // POST /api/traffic. Empty = ingestion is open (local development only).
  // Never log this value.
  trafficIngestToken: (process.env.TRAFFIC_INGEST_TOKEN || '').trim(),
  // Bearer token for camera stream management (POST/PATCH/DELETE
  // /api/streams). Empty = stream management is disabled. Never log it.
  streamAdminToken: (process.env.STREAM_ADMIN_TOKEN || '').trim(),
  // History sampling: at most one stored traffic record per intersection per
  // this many seconds of capture time (0 = store every observation). Changes
  // in emergency, pedestrians or stream attribution are always stored.
  historySampleSeconds: Math.max(0, num('HISTORY_SAMPLE_SECONDS', 5)),

  weights: {
    vehicles: num('WEIGHT_VEHICLES', 2),
    waiting: num('WEIGHT_WAITING', 3),
    queueLength: num('WEIGHT_QUEUE', 2),
  },

  timing: {
    MIN_GREEN_TIME: num('MIN_GREEN_TIME', 10),
    MAX_GREEN_TIME: num('MAX_GREEN_TIME', 45),
    YELLOW_TIME: num('YELLOW_TIME', 3),
    ALL_RED_TIME: num('ALL_RED_TIME', 1),
    SECONDS_PER_QUEUED_VEHICLE: num('SECONDS_PER_QUEUED_VEHICLE', 2),
    MAX_RED_TIME: num('MAX_RED_TIME', 90),
    MIN_PEDESTRIAN_CROSSING_TIME: num('MIN_PEDESTRIAN_CROSSING_TIME', 10),
    PEDESTRIAN_CLEARANCE_TIME: num('PEDESTRIAN_CLEARANCE_TIME', 3),
    PEDESTRIAN_MAX_WAIT: num('PEDESTRIAN_MAX_WAIT', 15),
    PEDESTRIAN_COOLDOWN: num('PEDESTRIAN_COOLDOWN', 20),
    EMERGENCY_MAX_HOLD_TIME: num('EMERGENCY_MAX_HOLD_TIME', 90),
    PERCEPTION_HOLD_TIME: num('PERCEPTION_HOLD_TIME', 3),
    DATA_TIMEOUT: num('DATA_TIMEOUT', 10),
    FALLBACK_GREEN_TIME: num('FALLBACK_GREEN_TIME', 20),
  },

  EMERGENCY_CONFIDENCE_THRESHOLD: num('EMERGENCY_CONFIDENCE_THRESHOLD', 0.8),

  // Network-wide coordination (services/networkCoordinator.js) and the
  // emergency corridor (services/emergencyCorridor.js).
  network: {
    ENABLED: (process.env.NETWORK_OPTIMIZATION || 'true').trim().toLowerCase() !== 'false',
    DECISION_INTERVAL: num('NETWORK_DECISION_INTERVAL', 2), // s between coordinator cycles
    LINK_LENGTH_M: num('NETWORK_LINK_LENGTH_M', 200),
    LINK_CAPACITY_VEHICLES: num('NETWORK_LINK_CAPACITY', 40),
    SPILLBACK_START: num('NETWORK_SPILLBACK_START', 0.7), // downstream occupancy where release is reduced
    SPILLBACK_BLOCK: num('NETWORK_SPILLBACK_BLOCK', 0.9), // ... and where it stops
    DOWNSTREAM_WEIGHT: num('NETWORK_DOWNSTREAM_WEIGHT', 0.5),
    LOOKAHEAD_RELEASE_SHARE: num('NETWORK_LOOKAHEAD_RELEASE_SHARE', 0.3),
    UPSTREAM_WEIGHT: num('NETWORK_UPSTREAM_WEIGHT', 2),
    SATURATION_FLOW: num('NETWORK_SATURATION_FLOW', 1.35), // veh/s released on green
    BLOCKED_CYCLES: num('NETWORK_BLOCKED_CYCLES', 2), // cycles a green's exit must stay blocked before it is cut
    CORRIDOR_LENGTH: num('EMERGENCY_CORRIDOR_LENGTH', 3), // intersections prepared ahead of an emergency vehicle
    CORRIDOR_PREPARE_SECONDS: num('EMERGENCY_CORRIDOR_PREPARE_SECONDS', 30),
    CORRIDOR_HOLD_SECONDS: num('EMERGENCY_CORRIDOR_HOLD_SECONDS', 8),
    CORRIDOR_NOMINAL_SPEED: num('EMERGENCY_CORRIDOR_NOMINAL_SPEED', 12), // m/s when the vehicle's speed is unknown
    CORRIDOR_TRACK_TIMEOUT: num('EMERGENCY_CORRIDOR_TRACK_TIMEOUT', 10), // s without an update before a track is dropped
    // A camera-detected emergency vehicle also prepares the next intersections
    // straight ahead (route assumed: there is no GPS feed).
    CORRIDOR_FROM_CAMERA: (process.env.EMERGENCY_CORRIDOR_FROM_CAMERA || 'true').trim().toLowerCase() !== 'false',
  },

  // Express "trust proxy" (TRUST_PROXY). Set it behind a reverse proxy
  // (Render, Nginx) so rate limits see the client address, not the proxy's.
  trustProxy: trustProxy(process.env.TRUST_PROXY),

  // Mobile navigation API (/api/v1). See docs/CONFIGURATION.md.
  navigation: {
    // Bearer token for road-feature management and report moderation.
    // Empty = those endpoints are disabled (503). Never log it, never ship it in an app.
    adminToken: (process.env.NAV_ADMIN_TOKEN || '').trim(),
    // HMAC secret that signs device tokens (>= 32 characters). Empty = a
    // per-process secret: tokens stop working at every restart. Never log it.
    deviceTokenSecret: (process.env.DEVICE_TOKEN_SECRET || '').trim(),
    deviceTokenTtlSeconds: Math.max(3600, num('DEVICE_TOKEN_TTL_DAYS', 30) * 86400),
    // Identifies this backend to the OSM services, as their usage policies require.
    userAgent: `SmartTraffic-Navigation/${PACKAGE_VERSION}${contactEmail ? ` (${contactEmail})` : ''}`,
    contactEmail,
    // Upstream requests queued longer than this are refused (503 PROVIDER_BUSY) instead of waiting.
    providerMaxWaitMs: Math.max(0, num('PROVIDER_MAX_WAIT_MS', 8000)),
    // A provider that keeps failing (timeouts, 5xx) is not called for this long:
    // requests fail at once with 503 PROVIDER_BUSY + Retry-After instead of hanging.
    providerCooldownMs: Math.max(0, num('PROVIDER_COOLDOWN_SECONDS', 30)) * 1000,

    routing: {
      url: routingUrl, // OSRM HTTP API; null = routing disabled
      profile: (process.env.ROUTING_PROFILE || 'driving').trim(),
      minIntervalMs: providerInterval('ROUTING_MIN_INTERVAL_MS', routingUrl),
      timeoutMs: Math.max(1000, num('ROUTING_TIMEOUT_MS', 15000)),
      maxRoutes: 4,
      // Extra alternatives through via points when OSRM returns fewer than asked
      // (each attempt = 2 upstream requests), within the time budget.
      viaAttempts: Math.max(0, Math.round(num('ROUTING_VIA_ATTEMPTS', 4))),
      alternativesBudgetMs: Math.max(0, num('ROUTING_ALTERNATIVES_BUDGET_MS', 6000)),
      cacheTtlSeconds: Math.max(0, num('ROUTING_CACHE_TTL_SECONDS', 300)),
      snapWarningMeters: 300,
    },

    geocoding: {
      url: geocodingUrl, // Nominatim-compatible API; null = place search disabled
      apiKey: (process.env.GEOCODING_API_KEY || '').trim(), // sent as ?key= (e.g. LocationIQ); never log it
      countryCodes: (process.env.GEOCODING_COUNTRY_CODES || '').trim().toLowerCase(),
      minIntervalMs: providerInterval('GEOCODING_MIN_INTERVAL_MS', geocodingUrl),
      timeoutMs: Math.max(1000, num('GEOCODING_TIMEOUT_MS', 10000)),
      cacheTtlSeconds: Math.max(0, num('GEOCODING_CACHE_TTL_SECONDS', 86400)),
      localSpanDeg: 0.3, // search near the user first, in a box at least this wide (~33 km)
    },

    overpass: {
      urls: overpassUrls, // tried in order; [] = OSM road features and nearby places disabled
      minIntervalMs: providerInterval('OVERPASS_MIN_INTERVAL_MS', overpassUrls),
      // Total time for one lookup, shared between the instances tried.
      timeoutMs: Math.max(1000, num('OVERPASS_TIMEOUT_MS', 12000)),
      cacheTtlSeconds: Math.max(0, num('OVERPASS_CACHE_TTL_SECONDS', 3600)),
      tileDeg: 0.05, // road features are cached in tiles of this size (~5.5 km)
      maxElements: 2000,
    },

    traffic: {
      // A live observation older than this is reported as stale.
      staleAfterSeconds: Math.max(1, num('NAV_TRAFFIC_STALE_SECONDS', 15)),
      // A monitored intersection is "on the route" within this distance of the line.
      routeMatchMeters: Math.max(1, num('NAV_ROUTE_MATCH_METERS', 60)),
      // Delay estimate per approach: mean wait + vehicles x this (one saturation headway).
      secondsPerVehicle: Math.max(0, num('NAV_SECONDS_PER_VEHICLE', 2)),
      longQueueVehicles: Math.max(1, num('NAV_LONG_QUEUE_VEHICLES', 10)),
      // Congestion level thresholds on the estimated delay of an approach.
      moderateDelaySeconds: Math.max(0, num('NAV_MODERATE_DELAY_SECONDS', 30)),
      heavyDelaySeconds: Math.max(0, num('NAV_HEAVY_DELAY_SECONDS', 90)),
      // Placeholder (unsurveyed) intersection positions are not matched to routes
      // unless this is true: a delay would be attached to the wrong road.
      includePlaceholderPositions: flag('NAV_ROUTE_INCLUDE_PLACEHOLDERS', false),
    },

    reports: {
      // Minutes a report stays visible without confirmations, per type.
      ttlMinutes: {
        accident: Math.max(5, num('REPORT_TTL_ACCIDENT_MINUTES', 60)),
        traffic_jam: Math.max(5, num('REPORT_TTL_TRAFFIC_JAM_MINUTES', 30)),
        road_closure: Math.max(5, num('REPORT_TTL_ROAD_CLOSURE_MINUTES', 240)),
        construction: Math.max(5, num('REPORT_TTL_CONSTRUCTION_MINUTES', 1440)),
        hazard: Math.max(5, num('REPORT_TTL_HAZARD_MINUTES', 120)),
      },
      // A confirmation extends a report by its TTL, up to this many TTLs after creation.
      maxLifetimeFactor: 4,
      // A new report this close to an active one of the same type confirms it instead.
      mergeRadiusMeters: Math.max(0, num('REPORT_MERGE_RADIUS_METERS', 75)),
      // Hidden as "dismissed" at this many dismissals, when they outnumber confirmations.
      dismissThreshold: Math.max(1, num('REPORT_DISMISS_THRESHOLD', 3)),
      maxActivePerDevice: Math.max(1, num('REPORT_MAX_ACTIVE_PER_DEVICE', 5)),
      // Reports are deleted this many days after they stop being active (0 = kept).
      retentionDays: Math.max(0, num('REPORT_RETENTION_DAYS', 30)),
      // Reports and closures within this distance of a route line are listed on it.
      routeAlertMeters: Math.max(1, num('REPORT_ROUTE_ALERT_METERS', 40)),
    },

    // Per client IP unless noted. Counters are in memory (one backend instance).
    rateLimits: {
      perMinute: Math.max(1, num('RATE_LIMIT_PER_MINUTE', 120)),
      searchPerMinute: Math.max(1, num('RATE_LIMIT_SEARCH_PER_MINUTE', 30)),
      routesPerMinute: Math.max(1, num('RATE_LIMIT_ROUTES_PER_MINUTE', 20)),
      placesPerMinute: Math.max(1, num('RATE_LIMIT_PLACES_PER_MINUTE', 20)),
      deviceRegistrationsPerHour: Math.max(1, num('RATE_LIMIT_DEVICE_REGISTRATIONS_PER_HOUR', 10)),
      reportsPerHour: Math.max(1, num('RATE_LIMIT_REPORTS_PER_HOUR', 10)), // per device
      votesPerHour: Math.max(1, num('RATE_LIMIT_VOTES_PER_HOUR', 60)), // per device
    },
  },
};

if (config.timing.MIN_GREEN_TIME > config.timing.MAX_GREEN_TIME) {
  console.warn('[config] MIN_GREEN_TIME > MAX_GREEN_TIME, clamping MIN to MAX');
  config.timing.MIN_GREEN_TIME = config.timing.MAX_GREEN_TIME;
}

module.exports = config;
