// Driver navigation page (frontend/navigation/) - the pure logic modules,
// tested without a browser, map or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'navigation', file)).href);

// ------------------------------------------------------------------- geo

test('distance to a route line', async () => {
  const { distanceToPolylineMeters, distanceMeters } = await load('geo.js');
  const line = [[35.56, 45.42], [35.56, 45.44]]; // east-west line
  assert.ok(distanceToPolylineMeters({ lat: 35.56, lng: 45.43 }, line) < 0.5, 'point on the line');
  const d = distanceToPolylineMeters({ lat: 35.5605, lng: 45.43 }, line); // ~55 m north
  assert.ok(Math.abs(d - distanceMeters({ lat: 35.5605, lng: 45.43 }, { lat: 35.56, lng: 45.43 })) < 1);
  assert.equal(distanceToPolylineMeters({ lat: 0, lng: 0 }, []), Infinity);
});

// --------------------------------------------------------------- routing

// --------------------------------------------------------------- traffic

const snapshot = (over = {}) => ({
  dataMode: 'live',
  intersectionId: 'main',
  name: 'Main Street',
  lat: 35.5617,
  lng: 45.4329,
  aiStatus: 'CONNECTED',
  serverTime: '2026-10-09T10:00:05.000Z',
  lastUpdate: '2026-10-09T10:00:03.000Z',
  traffic: {
    north: { vehicles: 3, queueLength: 2, waiting: 6, waitingTime: 6 },
    south: { vehicles: 1, queueLength: 0, waiting: 1, waitingTime: 1 },
    east: { vehicles: 15, queueLength: 12, waiting: 20, waitingTime: 20 },
    west: { vehicles: 0, queueLength: 0, waiting: 0, waitingTime: 0 },
  },
  emergency: { active: false },
  ...over,
});

test('traffic store: freshness on the server clock, simulation never stored', async () => {
  const { createTrafficStore } = await load('trafficStore.js');
  let now = Date.parse('2030-01-01T00:00:00Z'); // phone clock years off: must not matter
  const store = createTrafficStore({ staleAfterSeconds: 15, now: () => now });
  store.setConnection('connected');
  store.setIntersections([{ id: 'main', name: 'Main Street', lat: 35.5617, lng: 45.4329 }, { id: 'quiet', name: 'Quiet', lat: 35.57, lng: 45.44 }]);

  assert.equal(store.applySnapshot(snapshot({ dataMode: 'simulation' })), false);
  assert.equal(store.get('main').status, 'no-data');

  store.applySnapshot(snapshot());
  let v = store.get('main');
  assert.equal(v.status, 'live');
  assert.equal(v.ageSeconds, 2);
  assert.deepEqual(v.longestQueue, { direction: 'east', vehicles: 12 });
  assert.equal(v.approaches.east.waitingTime, 20);
  assert.equal(store.get('quiet').status, 'no-data');

  now += 14000;
  assert.equal(store.get('main').status, 'stale', 'older than staleAfterSeconds');
  store.applySnapshot(snapshot({ aiStatus: 'STALE' }));
  assert.equal(store.get('main').status, 'stale');

  store.applySnapshot(snapshot());
  store.setConnection('disconnected');
  v = store.get('main');
  assert.equal(v.status, 'offline', 'last known data while disconnected');
});

test('traffic store: emergency shown only for live data', async () => {
  const { createTrafficStore } = await load('trafficStore.js');
  const store = createTrafficStore({ now: () => Date.parse('2026-10-09T10:00:05Z') });
  store.setConnection('connected');
  const em = { active: true, type: 'ambulance', direction: 'north', confidence: 0.93, since: '2026-10-09T10:00:00Z' };
  store.applySnapshot(snapshot({ emergency: em }));
  assert.deepEqual(store.get('main').emergency, { type: 'ambulance', direction: 'north', confidence: 0.93, since: '2026-10-09T10:00:00Z' });
  store.applySnapshot(snapshot({ emergency: em, aiStatus: 'STALE' }));
  assert.equal(store.get('main').emergency, null);
});

// ------------------------------------------------------- route x traffic

const view = (id, lat, lng, extra = {}) => ({ id, name: id, lat, lng, located: true, status: 'live', ageSeconds: 3, longestQueue: { direction: 'east', vehicles: 2 }, emergency: null, ...extra });
const TRAFFIC_CFG = { routeMatchMeters: 60, longQueueVehicles: 10 };

test('routes are matched to monitored intersections near the line only', async () => {
  const { matchRouteToTraffic } = await load('routeTraffic.js');
  const route = { id: 'r', coordinates: [[35.56, 45.42], [35.56, 45.44]] };
  const near = view('near', 35.5603, 45.43, { longestQueue: { direction: 'east', vehicles: 14 } }); // ~33 m
  const far = view('far', 35.565, 45.43); // ~550 m
  const stale = view('stale', 35.56, 45.425, { status: 'stale', longestQueue: { direction: 'north', vehicles: 30 } });
  const { monitored, alerts } = matchRouteToTraffic(route, [far, near, stale, { ...near, id: 'nowhere', located: false }], TRAFFIC_CFG);
  assert.deepEqual(monitored.map((m) => m.intersection.id).sort(), ['near', 'stale']);
  assert.deepEqual(alerts.map((a) => a.key), ['near:queue'], 'stale data never raises an alert');
});

test('reroute suggestions only from real data', async () => {
  const { findRerouteSuggestion } = await load('routeTraffic.js');
  const alert = { key: 'hj:queue', kind: 'long-queue', intersectionId: 'hj', name: 'Hospital Junction', vehicles: 16, direction: 'east' };
  const routes = [{ id: 'r1', traffic: null }, { id: 'r2', traffic: null }];
  const matches = new Map([
    ['r1', { monitored: [{ intersection: { id: 'hj' } }], alerts: [alert] }],
    ['r2', { monitored: [], alerts: [] }],
  ]);
  const s = findRerouteSuggestion({ routes, selectedId: 'r1', matches, seenAlertKeys: new Set() });
  assert.deepEqual({ kind: s.kind, routeId: s.routeId }, { kind: 'avoid', routeId: 'r2' });
  assert.equal(findRerouteSuggestion({ routes, selectedId: 'r1', matches, seenAlertKeys: new Set(['hj:queue']) }), null, 'already seen');
  assert.equal(findRerouteSuggestion({ routes: [routes[0]], selectedId: 'r1', matches, seenAlertKeys: new Set() }), null, 'no alternative');

  const both = new Map([...matches, ['r2', { monitored: [{ intersection: { id: 'hj' } }], alerts: [alert] }]]);
  assert.equal(findRerouteSuggestion({ routes, selectedId: 'r1', matches: both, seenAlertKeys: new Set() }).kind, 'notice');

  const adjusted = [{ id: 'r1', traffic: { adjustedDuration: 900 } }, { id: 'r2', traffic: { adjustedDuration: 700 } }];
  const faster = findRerouteSuggestion({ routes: adjusted, selectedId: 'r1', matches: new Map(), seenAlertKeys: new Set() });
  assert.deepEqual({ kind: faster.kind, routeId: faster.routeId, saving: faster.savingSeconds }, { kind: 'faster', routeId: 'r2', saving: 200 });
  const marginal = [{ id: 'r1', traffic: { adjustedDuration: 700 } }, { id: 'r2', traffic: { adjustedDuration: 680 } }];
  assert.equal(findRerouteSuggestion({ routes: marginal, selectedId: 'r1', matches: new Map(), seenAlertKeys: new Set() }), null);
});

// --------------------------------------------------------------- hazards

test('approved reports: own loader, any zoom, reloaded once stale', async () => {
  const { createHazardLoader } = await load('hazardService.js');
  let calls = 0;
  let now = 0;
  const states = [];
  const provider = { kinds: ['road_closure'], fetchHazards: async () => { calls += 1; return [{ id: `r${calls}`, kind: 'road_closure', lat: 36.1, lng: 44 }]; } };
  const loader = createHazardLoader({ provider, onState: (s) => states.push(s), now: () => now, cfg: { minZoom: 0, retryAfterMs: 1000, debounceMs: 0, maxAgeMs: 50000 } });
  const view = { bbox: { south: 34.5, west: 42.3, north: 37.4, east: 46.3 }, zoom: 7 }; // whole region
  await loader.requestNow(view);
  assert.equal(states.at(-1).status, 'ready', 'loads at region zoom');
  await loader.requestNow(view);
  assert.equal(calls, 1, 'cached while fresh');
  now += 51000;
  await loader.requestNow(view);
  assert.equal(calls, 2, 'reloaded once stale, so newly approved reports appear');
  assert.equal(states.at(-1).hazards[0].id, 'r2');
});

test('a slow load is not restarted when the map moves inside its area', async () => {
  const { createHazardLoader } = await load('hazardService.js');
  let calls = 0;
  let release;
  const provider = {
    kinds: ['speed_camera'],
    fetchHazards: (bbox, { signal }) => { calls += 1; return new Promise((resolve, reject) => { release = () => resolve([]); signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'aborted' }))); }); },
  };
  const states = [];
  const loader = createHazardLoader({ provider, onState: (s) => states.push(s), cfg: { minZoom: 13, retryAfterMs: 0, debounceMs: 0 } });
  const first = loader.requestNow({ bbox: { south: 35.5, west: 45.4, north: 35.52, east: 45.42 }, zoom: 15 });
  await loader.requestNow({ bbox: { south: 35.505, west: 45.405, north: 35.515, east: 45.415 }, zoom: 16 }); // small pan/zoom
  assert.equal(calls, 1, 'the in-flight load was kept');
  release();
  await first;
  assert.equal(states.at(-1).status, 'ready');
});

test('hazard loader: zoom limit, area cache, kept results after an error', async () => {
  const { createHazardLoader } = await load('hazardService.js');
  const states = [];
  let calls = 0;
  let fail = false;
  const provider = { kinds: ['speed_camera'], fetchHazards: async () => { calls += 1; if (fail) throw Object.assign(new Error('504'), { code: 'provider' }); return [{ id: 'x', kind: 'speed_camera', lat: 35.5, lng: 45.4 }]; } };
  let now = 0;
  const loader = createHazardLoader({ provider, onState: (s) => states.push(s), now: () => now, cfg: { minZoom: 13, retryAfterMs: 30000, debounceMs: 0 } });
  const bbox = { south: 35.5, west: 45.4, north: 35.52, east: 45.42 };

  await loader.requestNow({ bbox, zoom: 11 });
  assert.equal(states.at(-1).status, 'zoom-in');
  assert.equal(calls, 0);

  await loader.requestNow({ bbox, zoom: 15 });
  assert.equal(states.at(-1).status, 'ready');
  await loader.requestNow({ bbox: { south: 35.505, west: 45.405, north: 35.515, east: 45.415 }, zoom: 16 });
  assert.equal(calls, 1, 'area already loaded');

  fail = true;
  await loader.requestNow({ bbox: { south: 36, west: 46, north: 36.02, east: 46.02 }, zoom: 15 });
  assert.equal(states.at(-1).status, 'error');
  assert.equal(states.at(-1).hazards.length, 1, 'earlier real results are kept');
  await loader.requestNow({ bbox: { south: 37, west: 47, north: 37.02, east: 47.02 }, zoom: 15 });
  assert.equal(calls, 2, 'backs off after an error');
  now += 31000;
  fail = false;
  await loader.requestNow({ bbox: { south: 37, west: 47, north: 37.02, east: 47.02 }, zoom: 15 });
  assert.equal(calls, 3);
  assert.equal(states.at(-1).status, 'ready');
});

// ------------------------------------------------------------- geocoding

test('formatting', async () => {
  const { formatDuration, formatDistance, formatDelay, formatAge } = await load('format.js');
  assert.equal(formatDuration(25), '< 1 min');
  assert.equal(formatDuration(3900), '1 h 5 min');
  assert.equal(formatDistance(432), '430 m');
  assert.equal(formatDistance(5120), '5.1 km');
  assert.equal(formatDelay(130), '+2 min');
  assert.equal(formatDelay(10), 'no delay');
  assert.equal(formatAge(4.4), '4 s ago');
  assert.equal(formatAge(null), 'never');
});

test('operator road features become verified hazards; unknown kinds and bad positions are dropped', async () => {
  const { parseRoadFeatures } = await load('hazardService.js');
  const out = parseRoadFeatures({ features: [
    { id: 'a', kind: 'speed_camera', lat: 35.56, lng: 45.43, name: 'Camera on Salim St', speedLimitKmh: 60, source: 'City traffic dept', updatedAt: '2026-11-09T10:00:00.000Z' },
    { id: 'b', kind: 'speed_bump', lat: 35.57, lng: 45.44, name: null },
    { id: 'c', kind: 'roadworks', lat: 35.57, lng: 45.44 },
    { id: 'd', kind: 'road_closure', lat: 135, lng: 45.44 },
  ] });
  assert.deepEqual(out.map((h) => [h.id, h.kind, h.label, h.verification]), [
    ['operator-a', 'speed_camera', 'Camera on Salim St', 'verified'],
    ['operator-b', 'speed_bump', 'Speed bump', 'verified'],
  ]);
  assert.equal(out[0].details.maxspeed, '60');
  assert.equal(out[1].source, 'SmartTraffic operator');
});

// ------------------------------------------ the provider, through the backend

const flush = async () => {};
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const backendRoute = (duration, coords, extra = {}) => ({
  id: 'rt_x', distance: 2000, duration, summary: 'Main Road', geometry: { type: 'LineString', coordinates: coords }, ...extra,
});

test('routes from the backend become [lat, lng] lines; unusable routes are dropped; no traffic is invented', async () => {
  const { normalizeBackendResponse, rankRoutes } = await load('routeService.js');
  const out = normalizeBackendResponse({
    routes: [
      backendRoute(600, [[45.4, 35.5], [45.5, 35.6]], { traffic: { adjustedDuration: 1, basis: 'live-ai', updatedAt: new Date().toISOString() } }),
      backendRoute(700, [[45.4, 35.5]]), // one point: not a line
      { ...backendRoute(800, [[45.4, 35.5], [45.5, 35.6]]), distance: 'far' },
      backendRoute(900, [[45.4, 35.5], [45.45, 35.55], [45.5, 35.6]]),
    ],
    snapWarnings: ['Start is 450 m from the nearest road.', 42],
  });
  assert.equal(out.routes.length, 2);
  assert.deepEqual(out.routes[0].coordinates, [[35.5, 45.4], [35.6, 45.5]], 'GeoJSON [lng, lat] becomes [lat, lng]');
  assert.equal(out.routes[0].traffic, null, 'live delay is added in the browser, once');
  assert.equal(out.routes[0].summary, 'Main Road');
  assert.deepEqual(out.snapWarnings, ['Start is 450 m from the nearest road.']);
  assert.equal(normalizeBackendResponse({ routes: [] }), null);
  assert.equal(normalizeBackendResponse(null), null);
  assert.equal(normalizeBackendResponse({ routes: [1, 2, 3, 4, 5].map((n) => backendRoute(n * 100, [[45, 35], [45.1, 35.1]])) }, { maxRoutes: 3 }).routes.length, 3);
  assert.deepEqual(rankRoutes(out.routes), { fastestId: out.routes[0].id, basis: 'base' });
  assert.deepEqual(rankRoutes([]), { fastestId: null, basis: 'base' });
});

test('planRoutes asks the backend only, validates input, and maps backend errors for the driver', async () => {
  const { planRoutes, RouteError } = await load('routeService.js');
  const start = { lat: 35.5, lng: 45.4 };
  const destination = { lat: 35.6, lng: 45.5 };
  const calls = [];
  const answer = (status, body) => async (url, init) => { calls.push({ url: String(url), init }); return jsonResponse(status, body); };

  const ok = await withFetch(answer(200, { ok: true, routes: [backendRoute(600, [[45.4, 35.5], [45.5, 35.6]])], snapWarnings: [] }), () => planRoutes(start, destination));
  assert.equal(ok.routes.length, 1);
  assert.equal(calls[0].url, '/api/v1/routes', 'same-origin backend, never a map provider');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { start, destination, maxRoutes: 4 });

  const failures = [
    [422, 'NO_ROUTE', 'no-route'], [422, 'POINT_NOT_ROUTABLE', 'no-route'], [429, 'RATE_LIMITED', 'busy'],
    [503, 'PROVIDER_QUOTA_EXCEEDED', 'busy'], [503, 'PROVIDER_BUSY', 'busy'], [503, 'FEATURE_DISABLED', 'provider'], [504, 'PROVIDER_TIMEOUT', 'timeout'],
  ];
  for (const [status, code, expected] of failures) {
    await assert.rejects(
      withFetch(answer(status, { ok: false, code, error: 'x' }), () => planRoutes(start, destination)),
      (e) => e instanceof RouteError && e.code === expected && !/geoapify|127\.0\.0\.1/i.test(e.message),
      code,
    );
  }
  await assert.rejects(withFetch(answer(500, null), () => planRoutes(start, destination)), (e) => e.code === 'provider');
  await assert.rejects(withFetch(async () => { throw new Error('down'); }, () => planRoutes(start, destination)), (e) => e.code === 'network');

  const before = calls.length;
  await assert.rejects(planRoutes({ lat: 99, lng: 0 }, destination), (e) => e.code === 'invalid-input');
  await assert.rejects(planRoutes(start, start), (e) => e.code === 'invalid-input');
  await assert.rejects(withFetch(answer(200, { ok: true, routes: [] }), () => planRoutes(start, destination)), (e) => e.code === 'no-route', 'an empty answer is no route, never a straight line');
  assert.equal(calls.length, before + 1, 'invalid input never reaches the backend');
  await flush();
});

test('place search goes through the backend; entries without a real position are dropped', async () => {
  const { parsePlaces, createGeocoder, GeocodeError } = await load('geocoder.js');
  const places = parsePlaces({ places: [
    { id: 'geoapify:1', name: ' Hospital ', address: 'Main St', lat: 35.5, lng: 45.4 },
    { id: 'geoapify:2', name: 'No position', lat: null, lng: null },
    { id: 'geoapify:3', name: 'Text position', lat: '35.5', lng: '45.4' },
    { id: 'geoapify:4', name: '', lat: 35.5, lng: 45.4 },
    { name: 'No id', lat: 0.5, lng: 0.5 },
  ] });
  assert.deepEqual(places.map((p) => p.name), ['Hospital', 'No id']);
  assert.equal(places[0].address, 'Main St');
  assert.deepEqual(parsePlaces({ places: 'x' }), []);

  const calls = [];
  const geocoder = createGeocoder();
  const search = (body, status = 200) => withFetch(async (url) => { calls.push(String(url)); return jsonResponse(status, body); },
    () => geocoder.search('hospital', { viewbox: { south: 35, west: 45, north: 36, east: 46 } }));
  const result = await search({ ok: true, scope: 'local', places: [{ id: 'a', name: 'A', lat: 35.5, lng: 45.5 }] });
  assert.equal(result.scope, 'local');
  const url = new URL(calls[0], 'http://x');
  assert.equal(url.pathname, '/api/v1/places/search');
  assert.equal(url.searchParams.get('q'), 'hospital');
  assert.equal(url.searchParams.get('lat'), '35.5', 'ranked towards the middle of the map view');
  assert.equal(url.searchParams.get('lng'), '45.5');
  assert.equal(url.searchParams.get('limit'), '5');
  await assert.rejects(search({ ok: false, code: 'RATE_LIMITED' }, 429), (e) => e instanceof GeocodeError && e.code === 'busy');
  await assert.rejects(search({ ok: false, code: 'FEATURE_DISABLED' }, 503), (e) => e.code === 'provider');
  await assert.rejects(geocoder.search('ab'), (e) => e.code === 'too-short');
  assert.equal(calls.length, 3, 'a too-short query is not sent');
});

test('the road feature request asks only for the operator kinds in view', async () => {
  const { createRoadFeatureProvider } = await load('hazardService.js');
  let requested = null;
  const provider = createRoadFeatureProvider({ url: '/api/v1/road-features' });
  await withFetch(async (url) => { requested = String(url); return jsonResponse(200, { features: [] }); }, () => provider.fetchHazards({ south: 1, west: 2, north: 3, east: 4 }));
  const query = new URL(requested, 'http://x').searchParams;
  assert.equal(query.get('kinds'), 'speed_camera,speed_bump,road_closure');
  assert.equal(query.has('sources'), false);
  assert.equal(requested.startsWith('/api/v1/road-features?'), true);
});

test('map config: read from the backend, validated, a failed request means no map (never a guess)', async () => {
  const cfg = await import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'mapConfig.js')).href);
  const map = {
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty', bounds: { south: 34.4, west: 42.3, north: 37.4, east: 46.4 }, minZoom: 6, maxZoom: 19, attribution: { text: 'x', url: 'https://openfreemap.org' },
  };
  assert.deepEqual((await withFetch(async () => jsonResponse(200, { map, searchAttribution: { text: 'Powered by Geoapify' } }), () => cfg.loadMapConfig())).map, map);
  assert.equal(await withFetch(async () => jsonResponse(200, { map: { ...map, styleUrl: 5 } }), () => cfg.loadMapConfig()), null, 'a style that is not a URL is no config');
  assert.equal(await withFetch(async () => jsonResponse(200, { map: { ...map, bounds: { south: 'a' } } }), () => cfg.loadMapConfig()), null);
  assert.equal(await withFetch(async () => jsonResponse(500, {}), () => cfg.loadMapConfig()), null);
  assert.equal(await withFetch(async () => { throw new Error('down'); }, () => cfg.loadMapConfig()), null, 'a failed request is no config, not a crash');

  assert.deepEqual(cfg.toMapBounds(map.bounds), [[42.3, 34.4], [46.4, 37.4]], 'MapLibre wants [[west, south], [east, north]]');
  assert.deepEqual(cfg.latLngsToLngLats([[35.5, 45.4], [36, 44]]), [[45.4, 35.5], [44, 36]], 'routes are [lat, lng], MapLibre wants [lng, lat]');
  const centre = cfg.boundsCenter(map.bounds);
  assert.ok(Math.abs(centre.lat - 35.9) < 1e-9 && Math.abs(centre.lng - 44.35) < 1e-9);
  assert.equal(cfg.insideBounds(map.bounds, { lat: 36, lng: 44 }), true);
  assert.equal(cfg.insideBounds(map.bounds, { lat: 33.3, lng: 44.4 }), false, 'Baghdad is outside the Kurdistan Region lock');
  const circle = cfg.circlePolygon({ lat: 36, lng: 44 }, 100, 8);
  assert.equal(circle.coordinates[0].length, 9, 'a closed ring');
  assert.deepEqual(circle.coordinates[0][0], circle.coordinates[0][8]);
  const radius = Math.hypot((circle.coordinates[0][0][0] - 44) * 111320 * Math.cos((36 * Math.PI) / 180), (circle.coordinates[0][0][1] - 36) * 110540);
  assert.ok(Math.abs(radius - 100) < 1, 'the circle has the requested radius in metres');
});

test('driver reports and Hawr places become map points; reports that are not active and bad positions are dropped', async () => {
  const { parseReports, parsePlaces } = await load('hazardService.js');
  const reports = parseReports({ reports: [
    { id: 'a1', type: 'accident', label: 'Accident', lat: 36.1, lng: 44.0, status: 'active', verification: 'unverified', description: 'Two cars', confirmations: 2, dismissals: 1, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: '2026-11-12T12:00:00.000Z' },
    { id: 'a2', type: 'accident', lat: 36.1, lng: 44.0, status: 'expired' },
    { id: 'a3', type: 'hazard', lat: 999, lng: 44.0, status: 'active' },
    { id: 7, type: 'hazard', lat: 36, lng: 44, status: 'active' },
  ] });
  assert.equal(reports.length, 1);
  assert.deepEqual([reports[0].id, reports[0].kind, reports[0].icon, reports[0].verification], ['report-a1', 'report', 'accident', 'unverified']);
  assert.equal(reports[0].details.votes, '2 confirmed, 1 disputed');
  const places = parsePlaces({ places: [{ id: 'p1', name: 'City Hospital', lat: 35.5, lng: 45.4, description: 'Main' }, { id: 'p2', name: 'Nowhere', lat: null, lng: 1 }, { name: 'No id', lat: 1, lng: 1 }] });
  assert.deepEqual(places.map((p) => [p.id, p.kind, p.label, p.source]), [['place-p1', 'place', 'City Hospital', 'Hawr']]);
  assert.deepEqual(parseReports(null), []);
  assert.deepEqual(parsePlaces({}), []);
});

test('the device session registers once, reuses its token, signs in again on a 401 and explains failures', async () => {
  const { createDeviceSession, ReportError } = await load('deviceSession.js');
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    const now = () => Date.parse('2026-11-12T10:00:00Z');
    const calls = [];
    let rejectNext = false;
    let issued = 0;
    const fetchFn = async (url, init) => {
      calls.push(`${init.method} ${url}`);
      if (url === '/api/v1/auth/device') { issued += 1; return jsonResponse(201, { token: `t${issued}`, expiresAt: '2026-12-12T10:00:00Z' }); }
      if (rejectNext) { rejectNext = false; return jsonResponse(401, { ok: false, code: 'INVALID_TOKEN', error: 'bad' }); }
      return jsonResponse(201, { ok: true, report: { id: 'r' } });
    };
    const session = createDeviceSession('k', { fetchFn, now });
    await session.postReport({ type: 'accident', lat: 36, lng: 44, description: '  ' });
    await session.postReport({ type: 'hazard', lat: 36, lng: 44 });
    assert.equal(issued, 1, 'one registration serves both reports');
    assert.equal(JSON.parse(store.get('k')).token, 't1', 'and is kept for the next page load');
    rejectNext = true;
    await session.postReport({ type: 'hazard', lat: 36, lng: 44 });
    assert.equal(issued, 2, 'a rejected token is replaced, the report is sent again once');
    assert.equal(calls.filter((c) => c === 'POST /api/v1/reports').length, 4);

    const failing = (status, body) => createDeviceSession('k2', { fetchFn: async (url) => (url === '/api/v1/auth/device' ? jsonResponse(201, { token: 't', expiresAt: '2026-12-12T10:00:00Z' }) : jsonResponse(status, body)), now });
    await assert.rejects(failing(429, {}).postReport({ type: 'hazard', lat: 1, lng: 1 }), (e) => e instanceof ReportError && e.code === 'RATE_LIMITED');
    await assert.rejects(failing(503, {}).postReport({ type: 'hazard', lat: 1, lng: 1 }), (e) => e.code === 'UNAVAILABLE');
    await assert.rejects(failing(400, { code: 'INVALID_REQUEST', error: 'type must be one of ...' }).postReport({ type: 'x', lat: 1, lng: 1 }), (e) => e.message.startsWith('type must be'));
    const down = createDeviceSession('k3', { fetchFn: async () => { throw new Error('offline'); }, now });
    await assert.rejects(down.postReport({ type: 'hazard', lat: 1, lng: 1 }), (e) => e.code === 'NETWORK');
  } finally {
    delete globalThis.localStorage;
  }
});

test('nothing in the web app or the backend still depends on the old public map services', () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..', '..');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', 'docs', 'data'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html|css)$/.test(entry.name)) files.push(full);
    }
  }(path.join(root, 'frontend')));
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', 'docs', 'data', 'scripts'].includes(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(full);
    }
  }(path.join(root, 'backend')));
  assert.ok(files.length > 50, 'the scan found the sources');
  const old = /project-osrm|nominatim\.openstreetmap|overpass-api|overpass\.private|overpass\.kumi|tile\.openstreetmap|router\.project/i;
  const hits = files.filter((f) => old.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(hits, [], 'old map service URLs found');
});

test('a map area wider than the backend allows is cut down around its centre', async () => {
  const { clampBBox, padBBox } = await load('geo.js');
  const wide = padBBox({ south: 35.0, west: 44.0, north: 35.3, east: 44.66 }, 0.25); // a big screen: 0.99 degrees wide after padding
  const area = clampBBox(wide, 0.45);
  assert.ok(Math.abs(area.east - area.west - 0.45) < 1e-9);
  assert.ok(Math.abs(area.north - area.south - 0.45) < 1e-9 || area.north - area.south < 0.45);
  assert.ok(Math.abs((area.east + area.west) / 2 - (wide.east + wide.west) / 2) < 1e-9, 'same centre');
  const small = { south: 1, west: 2, north: 1.1, east: 2.1 };
  assert.deepEqual(clampBBox(small, 0.45), small, 'a small area is left alone');
});

test('no trace of the removed map provider or of Leaflet is left in the sources, the docs or the env example', () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..', '..');
  const skip = new Set(['node_modules', 'graphify-out', '.git', 'data', 'package-lock.json']);
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|html|css|md|json|example|webmanifest)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(full);
    }
  }(root));
  assert.ok(files.length > 80, 'the scan found the sources');
  const removed = new RegExp(['tare' + 'ky', 'leaf' + 'let'].join('|'), 'i');
  const hits = files.filter((f) => removed.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepEqual(hits, [], 'files that still mention the removed provider or Leaflet');
});
