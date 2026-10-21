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
};

if (config.timing.MIN_GREEN_TIME > config.timing.MAX_GREEN_TIME) {
  console.warn('[config] MIN_GREEN_TIME > MAX_GREEN_TIME, clamping MIN to MAX');
  config.timing.MIN_GREEN_TIME = config.timing.MAX_GREEN_TIME;
}

module.exports = config;
