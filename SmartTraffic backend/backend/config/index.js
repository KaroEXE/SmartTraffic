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

/** Comma-separated env value, or `fallback` when empty. */
function list(name, fallback) {
  const items = (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function adminToken() {
  const raw = (process.env.ADMIN_TOKEN || '').trim();
  if (raw && raw.length < 16) {
    console.warn('[config] ADMIN_TOKEN is shorter than 16 characters - road report review is disabled');
    return '';
  }
  return raw;
}

const config = {
  port: num('PORT', 3000),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // Historical data store. Never log this value: it may contain credentials.
  mongodbUri: (process.env.MONGODB_URI || '').trim(),
  // Python/Flask camera stream shown on the dashboard's Live AI page, e.g.
  // http://<flask-host>:5000/video_feed. Sent to browsers, so never put
  // credentials in it. Empty = the page shows "not connected".
  aiStreamUrl: httpUrl('AI_STREAM_URL'),
  // Secret for the road-report review page (admin.html). Empty = reviewing
  // is disabled and nothing drivers report is ever published.
  adminToken: adminToken(),
  // Driver road reports (pending, approved, rejected). Plain JSON file so it
  // works without MongoDB.
  // OpenStreetMap data for the navigation map, fetched by the backend
  // (services/osmProxyService.js). Tried in order. The User-Agent identifies
  // this app, as the Overpass usage policy requires; a contact (URL or
  // e-mail) in it is recommended for production.
  overpassUrls: list('OVERPASS_URLS', [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ]),
  overpassUserAgent: (process.env.OVERPASS_USER_AGENT || '').trim() || 'SmartTraffic-Navigation/1.0 (traffic navigation prototype)',
  hazardReportsFile: (process.env.HAZARD_REPORTS_FILE || '').trim()
    || path.join(__dirname, '..', 'data', 'hazard-reports.json'),

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
};

if (config.timing.MIN_GREEN_TIME > config.timing.MAX_GREEN_TIME) {
  console.warn('[config] MIN_GREEN_TIME > MAX_GREEN_TIME, clamping MIN to MAX');
  config.timing.MIN_GREEN_TIME = config.timing.MAX_GREEN_TIME;
}

module.exports = config;
