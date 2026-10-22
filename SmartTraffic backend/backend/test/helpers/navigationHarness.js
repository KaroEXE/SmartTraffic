// Test harness for the mobile navigation API (/api/v1).
//
// startFakeProviders(): ONE local HTTP server that answers like OSRM
// (/osrm), Nominatim (/nominatim) and Overpass (/overpass). The backend
// reaches it over real HTTP with the real provider clients. Its answers are
// MOCKED fixtures around a test intersection, not real map data; the real
// services are exercised by scripts/smokeNavigation.js.
//
// startApi(): the real router, controllers, services and validation, with
// a real decision engine (fed test observations) on an ephemeral port.
const http = require('http');
const express = require('express');
const baseConfig = require('../../config');
const { createTrafficDecisionService } = require('../../services/trafficDecisionService');
const { createNavigationApi } = require('../../services/navigation');

const ADMIN_TOKEN = 'test-admin-token-0123456789';
// A monitored intersection and a local metric grid around it.
const IX = { lat: 35.5617, lng: 45.4329 };
const M_LAT = 1 / 110540;
const M_LNG = 1 / (111320 * Math.cos((IX.lat * Math.PI) / 180));
/** x metres east, y metres north of IX -> [lng, lat] */
const at = (x, y) => [IX.lng + x * M_LNG, IX.lat + y * M_LAT];
const latLng = (x, y) => { const [lng, lat] = at(x, y); return { lat, lng }; };

const START = latLng(0, 800);
const DESTINATION = latLng(0, -800);

const INTERSECTIONS = [
  { id: 'main', name: 'Main Street', lat: IX.lat, lng: IX.lng, positionSource: 'surveyed', grid: { col: 0, row: 0 } },
  { id: 'north-gate', name: 'North Gate', ...latLng(0, 400), positionSource: 'placeholder', grid: { col: 1, row: 0 } },
];

// ------------------------------------------------------------------- providers

const step = (type, location, name = 'Test Road', extra = {}) => ({
  distance: 100, duration: 10, name, mode: 'driving', maneuver: { type, location, bearing_after: 180, ...extra },
});
const osrmRoute = (points, duration, distance) => ({
  distance,
  duration,
  geometry: { type: 'LineString', coordinates: points.map(([x, y]) => at(x, y)) },
  legs: [{
    summary: 'Test Road',
    steps: [step('depart', at(...points[0])), step('turn', at(...points[1]), 'Cross Street', { modifier: 'left' }), step('arrive', at(...points[points.length - 1]))],
  }],
});
// Through the intersection southbound (enters from the north approach).
const THROUGH = osrmRoute([[0, 800], [0, 0], [0, -800]], 600, 1600);
// A bypass to the east, nowhere near the intersection.
const BYPASS = osrmRoute([[0, 800], [600, 400], [600, -400], [0, -800]], 640, 2100);
// Through a via point to the west (the extra alternative).
const VIA_WEST = osrmRoute([[0, 800], [-700, 0], [0, -800]], 900, 2200);

function startFakeProviders() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, userAgent: req.headers['user-agent'],
      });
      const send = (status, value) => {
        res.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/html' : 'application/json' });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };

      // ---- OSRM
      const route = /^\/osrm\/route\/v1\/driving\/(.+)$/.exec(url.pathname);
      if (route) {
        const points = decodeURIComponent(route[1]).split(';').map((p) => p.split(',').map(Number));
        const startLat = points[0][1];
        if (startLat === 10) return send(400, { code: 'NoSegment', message: 'Could not find a matching segment' });
        if (startLat === 11) return send(400, { code: 'NoRoute', message: 'Impossible route' });
        if (startLat === 12) return send(500, '<html>Internal error</html>');
        if (startLat === 13) return undefined; // never answers: timeout
        if (points.length === 3) return send(200, { code: 'Ok', routes: [VIA_WEST], waypoints: [{}, {}, {}] });
        return send(200, { code: 'Ok', routes: [THROUGH, BYPASS], waypoints: [{ distance: 5 }, { distance: 450 }] });
      }
      if (/^\/osrm\/nearest\/v1\/driving\//.test(url.pathname)) {
        return send(200, { code: 'Ok', waypoints: [{ name: '', location: at(-650, 0) }, { name: 'West Road', location: at(-700, 0) }] });
      }

      // ---- Nominatim
      if (url.pathname === '/nominatim/search') {
        const q = url.searchParams.get('q');
        if (q === 'nothing here' || (q === 'far away' && url.searchParams.get('bounded') === '1')) return send(200, []);
        return send(200, [{
          osm_type: 'node', osm_id: 42, lat: String(IX.lat), lon: String(IX.lng), name: `${q} result`, display_name: `${q} result, Main Street, Test City`,
          category: 'amenity', type: 'hospital', address: { road: 'Main Street', city: 'Test City', country_code: 'tc' },
        }]);
      }
      if (url.pathname === '/nominatim/reverse') {
        if (url.searchParams.get('lat').startsWith('1.')) return send(200, { error: 'Unable to geocode' });
        return send(200, {
          osm_type: 'way', osm_id: 7, lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon'), name: '', display_name: 'Main Street, Test City', category: 'highway', type: 'primary',
        });
      }

      // ---- Overpass
      if (url.pathname === '/overpass-down') return send(503, '<html>busy</html>');
      if (url.pathname === '/overpass') {
        const query = new URLSearchParams(body).get('data') || '';
        if (query.includes('around:')) {
          return send(200, {
            elements: [
              { type: 'node', id: 2, lat: IX.lat + 900 * M_LAT, lon: IX.lng, tags: { amenity: 'fuel', name: 'Far Fuel' } },
              { type: 'node', id: 1, lat: IX.lat + 100 * M_LAT, lon: IX.lng, tags: { amenity: 'fuel', brand: 'Near Fuel', opening_hours: '24/7' } },
              { type: 'node', id: 3, lat: IX.lat + 0.1, lon: IX.lng, tags: { amenity: 'fuel', name: 'Outside radius' } },
            ],
          });
        }
        return send(200, {
          elements: [
            { type: 'node', id: 100, lat: IX.lat, lon: IX.lng + 100 * M_LNG, tags: { highway: 'speed_camera', maxspeed: '60' } },
            { type: 'way', id: 200, center: { lat: IX.lat + 200 * M_LAT, lon: IX.lng }, tags: { traffic_calming: 'bump' } },
          ],
        });
      }
      return send(404, { error: 'unknown fake provider path' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        count: (prefix) => calls.filter((c) => c.path.startsWith(prefix)).length,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}

// ------------------------------------------------------------------------ api

function testConfig(providers, overrides = {}) {
  const config = structuredClone(baseConfig);
  const nav = config.navigation;
  config.navigation = {
    ...nav,
    adminToken: ADMIN_TOKEN,
    deviceTokenSecret: 'test-device-secret-0123456789abcdefghij',
    userAgent: 'SmartTraffic-Navigation/test (tests@example.invalid)',
    contactEmail: 'tests@example.invalid',
    providerMaxWaitMs: 8000,
    routing: {
      ...nav.routing, url: `${providers}/osrm`, minIntervalMs: 0, timeoutMs: 500, viaAttempts: 2, alternativesBudgetMs: 3000,
    },
    geocoding: {
      ...nav.geocoding, url: `${providers}/nominatim`, minIntervalMs: 0, timeoutMs: 500, apiKey: '', countryCodes: '',
    },
    overpass: {
      ...nav.overpass, urls: [`${providers}/overpass-down`, `${providers}/overpass`], minIntervalMs: 0, timeoutMs: 500,
    },
    traffic: { ...nav.traffic, includePlaceholderPositions: false },
    rateLimits: {
      perMinute: 10_000, searchPerMinute: 10_000, routesPerMinute: 10_000, placesPerMinute: 10_000,
      deviceRegistrationsPerHour: 10_000, reportsPerHour: 10_000, votesPerHour: 10_000,
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    config.navigation[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? { ...config.navigation[key], ...value }
      : value;
  }
  return config;
}

/**
 * Starts the API. options: providers (fake provider URL), overrides
 * (config.navigation keys), isConnected, models, now.
 */
async function startApi({
  providers, overrides, isConnected = () => false, models = {}, now = Date.now,
}) {
  const config = testConfig(providers, overrides);
  const engine = createTrafficDecisionService({ intersections: INTERSECTIONS, config: baseConfig });
  const quiet = { warn() {}, error() {}, log() {} };
  const navigation = createNavigationApi({
    config, engine, isConnected, models, now, log: quiet,
  });
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/v1', navigation.router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => { server.once('listening', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, { body, token, headers = {} } = {}) {
    const res = await fetch(origin + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    origin,
    config,
    engine,
    navigation,
    call,
    get: (path, opts) => call('GET', path, opts),
    post: (path, body, opts = {}) => call('POST', path, { ...opts, body }),
    patch: (path, body, opts = {}) => call('PATCH', path, { ...opts, body }),
    del: (path, opts) => call('DELETE', path, opts),
    async deviceToken(platform = 'android') {
      const r = await call('POST', '/api/v1/auth/device', { body: { platform } });
      return r.body.token;
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

/** Heavy traffic on the north approach of "main": 20 vehicles, 15 queued, 40 s wait -> 80 s delay. */
function ingestHeavyNorth(engine) {
  engine.ingest({
    intersectionId: 'main',
    traffic: {
      north: { vehicles: 20, queueLength: 15, waitingTime: 40 },
      south: { vehicles: 2, queueLength: 1, waitingTime: 5 },
      east: { vehicles: 4, queueLength: 2, waitingTime: 8 },
      west: null,
    },
    pedestrians: { north: false, south: false, east: false, west: false },
    emergency: { detected: false, type: null, direction: null, confidence: 0 },
  });
}

module.exports = {
  ADMIN_TOKEN, IX, M_LAT, M_LNG, at, latLng, START, DESTINATION, INTERSECTIONS,
  startFakeProviders, startApi, testConfig, ingestHeavyNorth,
};
