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
 * The operator token (NAV_ADMIN_TOKEN) opens the admin console and the road
 * feature, report and user tools: a short one can be guessed, so it is refused
 * (administration stays disabled) instead of used.
 */
function operatorToken(name) {
  const raw = (process.env[name] || '').trim();
  if (raw && raw.length < 16) {
    console.warn(`[config] ${name} is shorter than 16 characters - administration is DISABLED. Use a long random value: node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`);
    return '';
  }
  return raw;
}

/**
 * Allowed browser origins (CORS and Socket.IO), as plain data; utils/cors.js
 * turns it into the check. CORS_ORIGIN is a comma-separated list of exact
 * origins, or "*" for any origin (only for a public API without cookies).
 * Blank: any localhost origin outside production, none in production.
 * Requests without an Origin header (same-origin pages, native apps, curl)
 * are not affected.
 */
function corsSettings(raw, production) {
  const value = (raw || '').trim();
  if (value === '*') {
    if (production) console.warn('[config] CORS_ORIGIN=* allows every website to call this API from a browser; list your own origins instead');
    return { any: true, origins: [], allowLocalhost: false };
  }
  const origins = value.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return { any: false, origins, allowLocalhost: !origins.length && !production };
}

/** Express "trust proxy": blank = off, true/false, a hop count, or an address list. */
function trustProxy(raw) {
  const value = (raw || '').trim();
  if (!value || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^d+$/.test(value)) return Number(value);
  return value;
}

const PACKAGE_VERSION = require('../package.json').version;
const PRODUCTION = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

const config = {
  port: num('PORT', 3000),
  production: PRODUCTION,
  cors: corsSettings(process.env.CORS_ORIGIN, PRODUCTION),
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
    adminToken: operatorToken('NAV_ADMIN_TOKEN'),
    // HMAC secret that signs device tokens (>= 32 characters). Empty = a
    // per-process secret: tokens stop working at every restart. Never log it.
    deviceTokenSecret: (process.env.DEVICE_TOKEN_SECRET || '').trim(),
    deviceTokenTtlSeconds: Math.max(3600, num('DEVICE_TOKEN_TTL_DAYS', 30) * 86400),
    // HMAC secret that signs user tokens (/auth/signup, /auth/login), >= 32
    // characters, different from DEVICE_TOKEN_SECRET. Empty = a per-process
    // secret: users are signed out at every restart. Never log it.
    userTokenSecret: (process.env.USER_TOKEN_SECRET || '').trim(),
    userTokenTtlSeconds: Math.max(3600, num('USER_TOKEN_TTL_DAYS', 7) * 86400),
    userAgent: `SmartTraffic-Navigation/${PACKAGE_VERSION}`,
    // Upstream requests queued longer than this are refused (503 PROVIDER_BUSY) instead of waiting.
    providerMaxWaitMs: Math.max(0, num('PROVIDER_MAX_WAIT_MS', 8000)),
    // A provider that keeps failing (timeouts, 5xx) is not called for this long:
    // requests fail at once with 503 PROVIDER_BUSY + Retry-After instead of hanging.
    providerCooldownMs: Math.max(0, num('PROVIDER_COOLDOWN_SECONDS', 30)) * 1000,

    // Search, reverse geocoding, nearby places and (unless ROUTING_OSRM_URL is set) routing:
    // Geoapify (https://apidocs.geoapify.com). The key stays on this server and is sent in a request header.
    geoapify: {
      baseUrl: 'https://api.geoapify.com',
      apiKey: (process.env.GEOAPIFY_API_KEY || '').trim(),
      // The free plan allows 5 requests per second: starts are spaced just above that.
      minIntervalMs: 220,
      timeoutMs: 15000,
      // Credits this server may spend per UTC day (0 = no limit). The free plan is 3,000 credits a day:
      // the default leaves a margin. Cached answers cost nothing.
      dailyLimit: Math.max(0, Math.round(num('GEOAPIFY_DAILY_REQUEST_LIMIT', 2500))),
    },

    // The map, for the web and the mobile app: OpenFreeMap vector tiles, rendered by MapLibre. No key,
    // no registration, no request limit (openfreemap.org/tos). It offers no search, routing or traffic.
    // The apps are fixed to the Kurdistan Region and to the zoom range that is useful there.
    map: {
      provider: 'openfreemap',
      styleUrl: (httpUrl('OPENFREEMAP_STYLE_URL') || 'https://tiles.openfreemap.org/styles/liberty').replace(/\/+$/, ''),
      bounds: {
        south: 34.4, west: 42.3, north: 37.4, east: 46.4,
      },
      minZoom: 7,
      maxZoom: 19,
    },

    routing: {
      // A self-hosted OSRM (no default: there is no public server we may use). Unset = Geoapify.
      osrmUrl: (httpUrl('ROUTING_OSRM_URL') || '').replace(/\/+$/, ''),
      timeoutMs: 15000,
      maxRoutes: 4,
      cacheTtlSeconds: Math.max(0, num('ROUTING_CACHE_TTL_SECONDS', 300)),
      snapWarningMeters: 300,
    },

    places: {
      cacheTtlSeconds: Math.max(0, num('PLACES_CACHE_TTL_SECONDS', 86400)),
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
      // Search, routes and nearby places each cost provider quota: keep these low.
      searchPerMinute: Math.max(1, num('RATE_LIMIT_SEARCH_PER_MINUTE', 15)),
      routesPerMinute: Math.max(1, num('RATE_LIMIT_ROUTES_PER_MINUTE', 10)),
      placesPerMinute: Math.max(1, num('RATE_LIMIT_PLACES_PER_MINUTE', 10)),
      deviceRegistrationsPerHour: Math.max(1, num('RATE_LIMIT_DEVICE_REGISTRATIONS_PER_HOUR', 10)),
      reportsPerHour: Math.max(1, num('RATE_LIMIT_REPORTS_PER_HOUR', 10)), // per device
      votesPerHour: Math.max(1, num('RATE_LIMIT_VOTES_PER_HOUR', 60)), // per device
      signupsPerHour: Math.max(1, num('RATE_LIMIT_SIGNUPS_PER_HOUR', 10)), // per IP
      loginsPerHour: Math.max(1, num('RATE_LIMIT_LOGINS_PER_HOUR', 30)), // per IP
      loginsPerAccountPerHour: Math.max(1, num('RATE_LIMIT_LOGINS_PER_ACCOUNT_PER_HOUR', 10)), // per email
    },
  },
};

if (config.timing.MIN_GREEN_TIME > config.timing.MAX_GREEN_TIME) {
  console.warn('[config] MIN_GREEN_TIME > MAX_GREEN_TIME, clamping MIN to MAX');
  config.timing.MIN_GREEN_TIME = config.timing.MAX_GREEN_TIME;
}

module.exports = config;
