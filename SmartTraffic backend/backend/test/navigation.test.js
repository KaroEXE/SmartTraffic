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

const osrmRoute = (duration, coords) => ({
  distance: 2000, duration, legs: [{ summary: 'Main Road' }],
  geometry: { type: 'LineString', coordinates: coords },
});

test('OSRM request uses lng,lat order and asks for up to three alternatives (four routes)', async () => {
  const { buildOsrmUrl } = await load('routeService.js');
  const url = buildOsrmUrl({ lat: 35.1, lng: 45.2 }, { lat: 35.3, lng: 45.4 });
  assert.match(url, /\/route\/v1\/driving\/45\.2,35\.1;45\.4,35\.3\?/);
  assert.match(url, /alternatives=3/);
  assert.match(url, /geometries=geojson/);
});

test('OSRM routes are normalised to [lat, lng] lines; errors become RouteErrors', async () => {
  const { normalizeOsrmResponse, RouteError } = await load('routeService.js');
  const { routes, snapWarnings } = normalizeOsrmResponse({
    code: 'Ok',
    routes: [osrmRoute(300, [[45.2, 35.1], [45.3, 35.2]]), osrmRoute(360, [[45.2, 35.1], [45.25, 35.15], [45.3, 35.2]])],
    waypoints: [{ distance: 12 }, { distance: 640 }],
  });
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0].coordinates[0], [35.1, 45.2]);
  assert.equal(routes[0].summary, 'Main Road');
  assert.equal(routes[0].traffic, null, 'OSRM routes never carry a traffic adjustment');
  assert.equal(snapWarnings.length, 1);
  assert.match(snapWarnings[0], /Destination is 640 m from the nearest road/);

  assert.throws(() => normalizeOsrmResponse({ code: 'NoRoute', routes: [] }), (e) => e instanceof RouteError && e.code === 'no-route');
  assert.throws(() => normalizeOsrmResponse({ code: 'InvalidValue' }), (e) => e.code === 'provider');
  assert.throws(() => normalizeOsrmResponse({ code: 'Ok', routes: [{ distance: 1, duration: 1, geometry: { type: 'Point', coordinates: [1, 2] } }] }),
    (e) => e.code === 'no-route', 'a route without a line is not accepted');
});

test('only a complete live-AI adjustment counts as traffic-adjusted', async () => {
  const { validTrafficAdjustment } = await load('routeService.js');
  const ok = validTrafficAdjustment({ adjustedDuration: 420, basis: 'live-ai', updatedAt: '2026-10-09T10:00:00Z', alerts: [{ message: ' Queue at Main ' }, {}] }, 300);
  assert.deepEqual(ok, { adjustedDuration: 420, delay: 120, basis: 'live-ai', updatedAt: '2026-10-09T10:00:00Z', alerts: [{ message: 'Queue at Main' }] });
  assert.equal(validTrafficAdjustment({ adjustedDuration: 420, basis: 'historical', updatedAt: '2026-10-09T10:00:00Z' }, 300), null);
  assert.equal(validTrafficAdjustment({ adjustedDuration: NaN, basis: 'live-ai', updatedAt: '2026-10-09T10:00:00Z' }, 300), null);
  assert.equal(validTrafficAdjustment({ adjustedDuration: 420, basis: 'live-ai' }, 300), null, 'needs a timestamp');
  assert.equal(validTrafficAdjustment(null, 300), null);
});

test('backend routes keep a valid adjustment and drop an invalid one', async () => {
  const { normalizeBackendResponse } = await load('routeService.js');
  const routes = normalizeBackendResponse({ routes: [
    { ...osrmRoute(300, [[45.2, 35.1], [45.3, 35.2]]), traffic: { adjustedDuration: 360, basis: 'live-ai', updatedAt: '2026-10-09T10:00:00Z' } },
    { ...osrmRoute(320, [[45.2, 35.1], [45.3, 35.2]]), traffic: { adjustedDuration: 'soon' } },
  ] });
  assert.equal(routes[0].traffic.adjustedDuration, 360);
  assert.equal(routes[1].traffic, null);
  assert.equal(normalizeBackendResponse({ nope: true }), null);
});

test('fastest route uses live-adjusted times only when every route has one', async () => {
  const { rankRoutes } = await load('routeService.js');
  const r = (id, duration, adjusted) => ({ id, duration, traffic: adjusted === undefined ? null : { adjustedDuration: adjusted } });
  assert.deepEqual(rankRoutes([r('a', 300), r('b', 280)]), { fastestId: 'b', basis: 'base' });
  assert.deepEqual(rankRoutes([r('a', 300, 310), r('b', 280, 500)]), { fastestId: 'a', basis: 'live-ai' });
  assert.deepEqual(rankRoutes([r('a', 300, 310), r('b', 280)]), { fastestId: 'b', basis: 'base' }, 'mixed: no live claim');
});

test('planRoutes validates input and never falls back to a straight line', async () => {
  const { planRoutes, RouteError } = await load('routeService.js');
  await assert.rejects(planRoutes({ lat: 95, lng: 0 }, { lat: 1, lng: 1 }), (e) => e instanceof RouteError && e.code === 'invalid-input');
  await assert.rejects(planRoutes({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }), (e) => e.code === 'invalid-input');

  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 503, json: async () => { throw new Error('html'); } });
    await assert.rejects(planRoutes({ lat: 35.1, lng: 45.2 }, { lat: 35.3, lng: 45.4 }), (e) => e.code === 'provider');
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(planRoutes({ lat: 35.1, lng: 45.2 }, { lat: 35.3, lng: 45.4 }), (e) => e.code === 'network');
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [osrmRoute(300, [[45.2, 35.1], [45.25, 35.2], [45.4, 35.3]])], waypoints: [] }) });
    const result = await planRoutes({ lat: 35.1, lng: 45.2 }, { lat: 35.3, lng: 45.4 });
    assert.equal(result.trafficRouting, 'not-configured');
    assert.equal(result.routes[0].coordinates.length, 3, 'road geometry from the provider');
  } finally {
    global.fetch = realFetch;
  }
});

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

test('Overpass data becomes hazards; nothing is invented', async () => {
  const { parseOverpass, buildOverpassQuery } = await load('hazardService.js');
  const hazards = parseOverpass({ elements: [
    { type: 'node', id: 1, lat: 35.56, lon: 45.43, tags: { highway: 'speed_camera', maxspeed: '60' } },
    { type: 'way', id: 2, center: { lat: 35.57, lon: 45.44 }, tags: { traffic_calming: 'hump' } },
    { type: 'node', id: 3, lat: 35.58, lon: 45.45, tags: { traffic_calming: 'chicane' } },
    { type: 'node', id: 4, tags: { highway: 'speed_camera' } },
  ] });
  assert.deepEqual(hazards.map((h) => [h.id, h.kind, h.label]), [['osm-node-1', 'speed_camera', 'Speed camera'], ['osm-way-2', 'speed_bump', 'Speed hump']]);
  assert.equal(hazards[0].details.maxspeed, '60');
  assert.equal(hazards[0].verification, 'community');
  assert.equal(hazards[0].url, 'https://www.openstreetmap.org/node/1');
  assert.deepEqual(parseOverpass({ elements: [] }), [], 'empty area stays empty');
  assert.match(buildOverpassQuery({ south: 1, west: 2, north: 3, east: 4 }), /node\["highway"="speed_camera"\]\(1,2,3,4\)/);
});

test('backend hazards are validated; unknown verification counts as unverified', async () => {
  const { parseBackendHazards } = await load('hazardService.js');
  const out = parseBackendHazards({ hazards: [
    { id: 'a', kind: 'road_closure', lat: 35.5, lng: 45.4, verification: 'verified', source: 'City traffic dept' },
    { id: 'b', kind: 'speed_camera', lat: 35.5, lng: 45.4, verification: 'trust-me' },
    { id: 'c', kind: 'pothole', lat: 35.5, lng: 45.4 },
    { id: 'd', kind: 'speed_bump', lat: 135, lng: 45.4 },
  ] });
  assert.deepEqual(out.map((h) => [h.id, h.verification]), [['backend-a', 'verified'], ['backend-b', 'unverified']]);
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

test('geocoder parsing and local search area', async () => {
  const { parseNominatim, localSearchBox } = await load('geocoder.js');
  const places = parseNominatim([
    { osm_type: 'way', osm_id: 7, lat: '35.53', lon: '45.45', name: 'University of Sulaimani', display_name: 'University of Sulaimani, Sulaymaniyah' },
    { osm_type: 'node', osm_id: 8, lat: 'x', lon: '45' },
  ]);
  assert.deepEqual(places, [{ id: 'way-7', name: 'University of Sulaimani', address: 'University of Sulaimani, Sulaymaniyah', lat: 35.53, lng: 45.45 }]);

  const box = localSearchBox({ south: 35.56, west: 45.43, north: 35.57, east: 45.44 }, 0.3);
  assert.ok(Math.abs(box.north - box.south - 0.3) < 1e-9, 'small views are widened');
  assert.ok(Math.abs((box.north + box.south) / 2 - 35.565) < 1e-9, 'centred on the view');
});

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
