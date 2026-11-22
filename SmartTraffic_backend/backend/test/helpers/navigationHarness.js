// Test harness for the mobile navigation API (/api/v1).
//
// startFakeProviders(): ONE local HTTP server that answers like Geoapify (routing only: search,
// reverse geocoding and nearby places are our own PostGIS database now) and, under /osrm, like a
// self-hosted OSRM. The routes are built in Geoapify's format around a test intersection. The real
// routing provider is exercised by scripts/smokeNavigation.js with a real key.
//
// fakeGeoRepository(): a stand-in for the SQL repository (rows in the database shape); the SQL
// itself is tested against a real PostGIS database in test/geoDatabase.test.js.
//
// startApi(): the real router, controllers, services and validation, with
// a real decision engine (fed test observations) on an ephemeral port.
const http = require('http');
const express = require('express');
const baseConfig = require('../../config');
const { createTrafficDecisionService } = require('../../services/trafficDecisionService');
const { createNavigationApi } = require('../../services/navigation');
const { createGeoService } = require('../../services/geo/geoService');

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
  { id: 'north-gate', name: 'North Gate', lat: null, lng: null, positionSource: 'unknown', grid: { col: 1, row: 0 } },
];

// ------------------------------------------------------------------- providers

const fs = require('fs');
const path = require('path');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'geoapify', name), 'utf8'));

// A route in Geoapify's format (GeoJSON feature, MultiLineString [lng, lat], legs with steps), around the test intersection.
const geoRoute = (points, time, distance, nudge = 0) => {
  const line = points.map(([x, y]) => at(x + nudge, y));
  const last = line.length - 1;
  const step = (from, to, text, type) => ({
    from_index: from, to_index: to, distance: Math.round(distance / (line.length - 1)), time: Math.round(time / (line.length - 1)), instruction: { text, type },
  });
  return {
    type: 'Feature',
    properties: {
      mode: 'drive',
      waypoints: [{ location: line[0], original_index: 0 }, { location: line[last], original_index: 1 }],
      units: 'metric',
      distance,
      distance_units: 'meters',
      time,
      legs: [{
        distance,
        time,
        steps: [
          step(0, 1, 'Drive south.', 'StartAtLeft'),
          step(1, last, 'Turn left onto Cross Street.', 'Left'),
          { ...step(last, last, 'Your destination is on the left.', 'DestinationReachedLeft'), distance: 0, time: 0 },
        ],
      }],
    },
    geometry: { type: 'MultiLineString', coordinates: [line] },
  };
};
// Through the intersection southbound (enters from the north approach).
const THROUGH = geoRoute([[0, 800], [0, 0], [0, -800]], 600, 1600);
// A bypass to the east, nowhere near the intersection.
const BYPASS = geoRoute([[0, 800], [600, 400], [600, -400], [0, -800]], 640, 2100);
// The same road as THROUGH, a few metres aside: a copy, not an alternative.
const COPY = geoRoute([[0, 800], [0, 0], [0, -800]], 605, 1600, 0.00001);

const TEST_KEY = 'test-geoapify-key-0123456789';
const geoError = (status, message) => ({ statusCode: status, error: status === 401 ? 'Unauthorized' : 'Bad Request', message });

function startFakeProviders() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, userAgent: req.headers['user-agent'], apiKey: req.headers['x-api-key'],
      });
      const send = (status, value, headers = {}) => {
        res.writeHead(status, { 'Content-Type': typeof value === 'string' ? 'text/html' : 'application/json', ...headers });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };

      // ---- a self-hosted OSRM (no key)
      const osrm = /^\/osrm\/route\/v1\/driving\/(.+)$/.exec(url.pathname);
      if (osrm) {
        const points = decodeURIComponent(osrm[1]).split(';').map((p) => p.split(',').map(Number));
        if (points[0][1] === 10) return send(400, { code: 'NoSegment', message: 'no segment' });
        const route = (feature) => ({
          distance: feature.properties.distance,
          duration: feature.properties.time,
          geometry: { type: 'LineString', coordinates: feature.geometry.coordinates[0] },
          legs: [{ summary: 'Test Road', steps: [] }],
        });
        const routes = url.searchParams.get('alternatives') === 'false' ? [route(THROUGH)] : [route(THROUGH), route(BYPASS)];
        return send(200, { code: 'Ok', routes, waypoints: [{ location: points[0], distance: 5 }, { location: [points[1][0], points[1][1] + 450 * M_LAT], distance: 450 }] });
      }

      // ---- Geoapify: the key goes in the x-api-key header; a key in the URL would leak into logs
      if (url.searchParams.has('apiKey')) return send(400, geoError(400, 'the key must not be in the URL'));
      if (req.headers['x-api-key'] !== TEST_KEY) return send(401, geoError(401, 'Invalid apiKey'));

      if (url.pathname === '/v1/routing') {
        const [start] = (url.searchParams.get('waypoints') || '').split('|').map((p) => p.split(',').map(Number));
        if (!start || Number.isNaN(start[0])) return send(400, geoError(400, '"waypoints[0]" does not match any of the allowed types'));
        if (start[0] === 10) return send(400, geoError(400, 'No suitable edges near location. Please check waypoint coordinate order (lat/lon).'));
        if (start[0] === 11) return send(400, geoError(400, 'Route not found'));
        if (start[0] === 12) return send(500, '<html>Internal error</html>');
        if (start[0] === 13) return undefined; // never answers: timeout
        if (start[0] === 14) return send(429, geoError(429, 'Too many requests'), { 'Retry-After': '2' });
        if (start[0] === 15) return send(401, geoError(401, 'Invalid apiKey'));
        const feature = { balanced: THROUGH, short: BYPASS, less_maneuvers: COPY }[url.searchParams.get('type') || 'balanced'];
        return send(200, { type: 'FeatureCollection', features: [feature], properties: { mode: 'drive' } });
      }
      return send(404, geoError(404, 'unknown fake provider path'));
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

/**
 * A stand-in for repositories/geoRepository.js: every method answers "nothing here" unless a test
 * gives it rows in the DATABASE'S row shape (snake_case). The real createGeoService (row -> API shape,
 * language names, reverse-geocode composition) runs on top of it. What the SQL itself returns is
 * tested against a real PostGIS database in test/geoDatabase.test.js, not here.
 */
function fakeGeoRepository(overrides = {}) {
  const calls = [];
  const record = (name, fallback) => async (args) => { calls.push({ name, args }); return typeof fallback === 'function' ? fallback(args) : fallback; };
  return {
    calls,
    normalize: record('normalize', (t) => String(t).toLowerCase()),
    searchPlaces: record('searchPlaces', (a) => ({ normalized: a.query.toLowerCase(), rows: [] })),
    findNearbyPlaces: record('findNearbyPlaces', []),
    findPlacesInBBox: record('findPlacesInBBox', []),
    findNearbyRoads: record('findNearbyRoads', []),
    findNearestRoad: record('findNearestRoad', null),
    distanceMeters: record('distanceMeters', 0),
    findNearestAddress: record('findNearestAddress', null),
    findAdminAreasAt: record('findAdminAreasAt', []),
    findNearestSettlements: record('findNearestSettlements', []),
    findNearestPoi: record('findNearestPoi', null),
    ...overrides,
  };
}

function testConfig(providers, overrides = {}) {
  const config = structuredClone(baseConfig);
  const nav = config.navigation;
  config.navigation = {
    ...nav,
    adminToken: ADMIN_TOKEN,
    deviceTokenSecret: 'test-device-secret-0123456789abcdefghij',
    userAgent: 'SmartTraffic-Navigation/test',
    providerMaxWaitMs: 8000,
    geoapify: {
      ...nav.geoapify, baseUrl: providers, apiKey: TEST_KEY, minIntervalMs: 0, timeoutMs: 500,
    },
    routing: { ...nav.routing, osrmUrl: '', timeoutMs: 500 },
    traffic: { ...nav.traffic },
    rateLimits: {
      perMinute: 10_000, searchPerMinute: 10_000, routesPerMinute: 10_000, placesPerMinute: 10_000,
      deviceRegistrationsPerHour: 10_000, reportsPerHour: 10_000, votesPerHour: 10_000,
      signupsPerHour: 10_000, loginsPerHour: 10_000, loginsPerAccountPerHour: 10_000,
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
  geoRepository = fakeGeoRepository(), geoEnabled = true,
}) {
  const config = testConfig(providers, overrides);
  const engine = createTrafficDecisionService({ intersections: INTERSECTIONS, config: baseConfig });
  const quiet = { warn() {}, error() {}, log() {} };
  const geo = createGeoService({ repository: geoRepository, enabled: geoEnabled });
  const navigation = createNavigationApi({
    config, engine, geo, isConnected, models, now, log: quiet,
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
    geo,
    geoRepository,
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
  ADMIN_TOKEN, TEST_KEY, fixture, IX, M_LAT, M_LNG, at, latLng, START, DESTINATION, INTERSECTIONS,
  startFakeProviders, startApi, testConfig, ingestHeavyNorth, fakeGeoRepository,
};
