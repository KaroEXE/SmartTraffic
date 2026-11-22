// Mobile navigation API (/api/v1) over HTTP: real router, controllers,
// services, validation and decision engine on an ephemeral port. Providers
// are a local fake (test/helpers/navigationHarness.js) reached over real
// HTTP. No database here (reports and operator features answer 503);
// test/navigationDatabase.test.js covers them against a real MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADMIN_TOKEN, TEST_KEY, START, DESTINATION, IX, latLng, startFakeProviders, startApi, ingestHeavyNorth, fakeGeoRepository,
} = require('./helpers/navigationHarness');
const spec = require('../docs/openapi');
const { createNavigationRoutes } = require('../routes/navigationRoutes');
const { createLiveTrafficService } = require('../services/navigation/liveTrafficService');
const { validateRouteRequest, validateReportInput, validateFeatureInput } = require('../utils/navValidation');

let providers;
let api;

test.before(async () => {
  providers = await startFakeProviders();
  api = await startApi({ providers: providers.url });
});
test.after(async () => {
  await api.close();
  await providers.close();
});

// ----------------------------------------------------------------- app + auth

test('GET /config describes features, limits and attribution', async () => {
  const r = await api.get('/api/v1/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.apiVersion, '1');
  assert.equal(r.body.features.routing.available, true);
  assert.equal(r.body.features.placeSearch.available, true);
  assert.equal(r.body.features.reports.available, false, 'no database in this test');
  assert.equal(r.body.features.liveTraffic.monitoredIntersections, 2);
  assert.deepEqual(r.body.features.reports.types, ['accident', 'traffic_jam', 'road_closure', 'construction', 'hazard']);
  assert.equal(r.body.attribution[0].provider, 'OpenFreeMap');
  assert.match(r.body.attribution[0].text, /OpenFreeMap/);
  assert.equal(r.body.attribution[1].provider, 'OpenStreetMap');
  assert.deepEqual(r.body.attribution[1].requiredFor, ['placeSearch', 'placesNearby']);
  assert.equal(r.body.attribution[2].provider, 'Geoapify', 'only routing is still Geoapify');
  assert.match(r.body.attribution[2].text, /Powered by Geoapify/);
  assert.deepEqual(r.body.attribution[2].requiredFor, ['routing']);
  assert.equal(r.body.features.routing.provider, 'geoapify');
  assert.equal(r.body.features.placeSearch.provider, 'postgis');
  assert.equal(r.body.features.map.provider, 'openfreemap');
  assert.match(r.body.features.map.styleUrl, /^https:\/\/tiles\.openfreemap\.org\/styles\//);
  assert.deepEqual(r.body.features.map.bounds, { south: 34.4, west: 42.3, north: 37.4, east: 46.4 });
  assert.equal(JSON.stringify(r.body).includes(TEST_KEY), false, 'no key in /config');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('POST /auth/device issues a token; a valid one is kept; a bad one is refused', async () => {
  const created = await api.post('/api/v1/auth/device', { platform: 'ios', appVersion: '1.2.0' });
  assert.equal(created.status, 201);
  assert.equal(created.body.tokenType, 'Bearer');
  assert.match(created.body.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.match(created.body.deviceId, /^[0-9a-f-]{36}$/);

  const again = await api.post('/api/v1/auth/device', undefined, { token: created.body.token });
  assert.equal(again.status, 200);
  assert.equal(again.body.renewed, false);
  assert.equal(again.body.deviceId, created.body.deviceId);
  assert.equal(again.body.token, undefined, 'still valid: keep the current token');

  const empty = await api.post('/api/v1/auth/device');
  assert.equal(empty.status, 201, 'the body is optional');

  const bad = await api.post('/api/v1/auth/device', {}, { token: 'not.a.token' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.code, 'DEVICE_TOKEN_INVALID');
  const badPlatform = await api.post('/api/v1/auth/device', { platform: 'symbian' });
  assert.equal(badPlatform.status, 400);
  assert.equal(badPlatform.body.code, 'INVALID_REQUEST');
});

// --------------------------------------------------------------------- places

// The place endpoints are answered by Redoz's own PostGIS service (services/geo). Here the repository is a
// stand-in that returns rows in the database's shape, so the HTTP layer, validation, language handling,
// reverse-geocode composition and category mapping run for real. What the SQL returns for real OpenStreetMap
// data is tested in test/geoDatabase.test.js (needs DATABASE_URL).

/** A search_entities row as the repository returns it. */
const row = (overrides = {}) => ({
  place_key: 'osm:w1001',
  source: 'osm',
  entity: 'poi',
  osm_type: 'w',
  osm_id: 1001,
  name: 'Test Hospital',
  names: { name: 'Test Hospital', 'name:ar': 'مستشفى الاختبار', 'name:ckb': 'نەخۆشخانەی تاقیکردنەوە', 'name:en': 'Test Hospital' },
  category: 'hospital',
  type: 'hospital',
  lat: IX.lat,
  lng: IX.lng,
  bbox: null,
  address: { street: 'Test Street', city: 'Test City' },
  address_text: 'Test Street, Test City',
  city: 'Test City',
  state: 'Test Governorate',
  details: {},
  importance: 0.6,
  verified: false,
  rating: null,
  rating_count: 0,
  distance_m: null,
  ...overrides,
});

test('GET /places/search: PostGIS search biased near the user, names in the reader\'s language, no external provider', async () => {
  const geoRepository = fakeGeoRepository({
    searchPlaces: async (args) => {
      geoRepository.calls.push({ name: 'searchPlaces', args });
      return { normalized: 'x', rows: [row({ distance_m: 120.4 })] };
    },
  });
  const local = await startApi({ providers: providers.url, geoRepository });
  try {
    const before = providers.calls.length;
    const q = 'مستشفى';
    const r = await local.get(`/api/v1/places/search?q=${encodeURIComponent(q)}&lat=${IX.lat}&lng=${IX.lng}&lang=ku&limit=5`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.scope, 'local', 'ranked near the given point');
    assert.equal(r.body.count, 1);
    const [place] = r.body.places;
    assert.equal(place.id, 'osm:w1001');
    assert.equal(place.name, 'نەخۆشخانەی تاقیکردنەوە', 'the Kurdish name when Kurdish is asked for');
    assert.equal(place.address, 'Test Street, Test City');
    assert.equal(place.addressDetails.road, 'Test Street');
    assert.equal(place.addressDetails.state, 'Test Governorate');
    assert.equal(place.lat, IX.lat);
    assert.equal(place.category, 'hospital');
    assert.equal(place.source, 'osm');
    assert.equal((await local.get(`/api/v1/places/search?q=${encodeURIComponent(q)}&lang=ar`)).body.places[0].name, 'مستشفى الاختبار');
    assert.equal((await local.get(`/api/v1/places/search?q=${encodeURIComponent(q)}`)).body.places[0].name, 'Test Hospital', 'the local name by default');

    const call = geoRepository.calls.find((c) => c.name === 'searchPlaces');
    assert.equal(call.args.query, q, 'the repository folds and matches the text itself');
    assert.deepEqual(call.args.near, { lat: IX.lat, lng: IX.lng });
    assert.equal(call.args.limit, 6, 'one more than asked for, to know whether another page exists');
    assert.equal(providers.calls.length, before, 'no request left for an external provider');

    const global = await local.get(`/api/v1/places/search?q=${encodeURIComponent(q)}`);
    assert.equal(global.body.scope, 'global');
    assert.equal(r.body.attribution.provider, 'OpenStreetMap');
    assert.doesNotMatch(JSON.stringify(r.body.attribution), /Geoapify/);

    const none = await local.get('/api/v1/places/search?q=nothing%20here');
    assert.equal(none.status, 200);
    assert.ok(Array.isArray(none.body.places));
    const short = await local.get('/api/v1/places/search?q=ab');
    assert.equal(short.status, 400);
    assert.equal(short.body.code, 'INVALID_REQUEST');
    assert.ok(short.body.details.length);
  } finally { await local.close(); }
});

test('GET /places/reverse composes street, area and city from PostGIS lookups, or null where there is nothing', async () => {
  const area = (admin_level, name) => ({ osm_id: admin_level, admin_level, name, names: { name, 'name:en': name } });
  const geoRepository = fakeGeoRepository({
    findNearestRoad: async () => ({
      osm_id: 55, name: 'Test Road', names: { name: 'Test Road' }, highway: 'residential', distance_m: 12.2,
    }),
    findAdminAreasAt: async () => [area(8, 'Test City'), area(4, 'Test Governorate'), area(2, 'Test Country')],
  });
  const local = await startApi({ providers: providers.url, geoRepository });
  try {
    const r = await local.get(`/api/v1/places/reverse?lat=${IX.lat}&lng=${IX.lng}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.place.name, 'Test Road');
    assert.equal(r.body.place.address, 'Test Road, Test City, Test Governorate, Test Country');
    assert.equal(r.body.place.lat, IX.lat, 'the pin is where the user tapped');
    assert.equal(r.body.place.addressDetails.state, 'Test Governorate');
    assert.equal(r.body.place.addressDetails.road, 'Test Road');
    assert.equal(r.body.attribution.provider, 'OpenStreetMap');
  } finally { await local.close(); }
  const none = await api.get('/api/v1/places/reverse?lat=1.5&lng=1.5');
  assert.equal(none.body.place, null, 'nothing known at that point: null, never an invented address');
  assert.equal((await api.get('/api/v1/places/reverse?lat=95&lng=1')).status, 400);
});

test('GET /places/nearby: our categories map to PostGIS categories, nearest first, nothing invented', async () => {
  const geoRepository = fakeGeoRepository({
    findNearbyPlaces: async (args) => {
      geoRepository.calls.push({ name: 'findNearbyPlaces', args });
      if (args.categories[0] === 'hotel') return [];
      return [
        row({
          place_key: 'osm:n7', name: 'Test Fuel', names: { name: 'Test Fuel', 'name:ar': 'وقود الاختبار' }, category: 'fuel', type: 'fuel', distance_m: 310.6, details: { brand: 'Brand', opening_hours: '24/7' },
        }),
        row({
          place_key: 'osm:n8', name: null, names: {}, category: 'fuel', type: 'fuel', distance_m: 700, details: {},
        }),
      ];
    },
  });
  const local = await startApi({ providers: providers.url, geoRepository });
  try {
    const r = await local.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=fuel&radius=1000&limit=5`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.places.map((p) => p.id), ['osm:n7', 'osm:n8'], 'in the order the database gave: nearest first');
    assert.deepEqual(r.body.places.map((p) => p.distanceMeters), [311, 700]);
    assert.equal(r.body.places[0].category, 'fuel');
    assert.equal(r.body.places[0].rating, null, 'no rating exists: null, not 0 stars');
    assert.equal(r.body.places[0].openingHours, '24/7', 'from the OSM tag');
    assert.deepEqual(r.body.places[0].details, { brand: 'Brand', operator: null, openingHours: '24/7', phone: null, website: null }, 'keys of the earlier answer stay');
    assert.equal(r.body.places[1].name, null, 'an unnamed station has no name: null, not a made-up one');
    const call = geoRepository.calls.find((c) => c.name === 'findNearbyPlaces');
    assert.deepEqual(call.args, {
      lat: IX.lat, lng: IX.lng, radius: 1000, categories: ['fuel'], limit: 5,
    });
    const atm = await local.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=atm`);
    assert.deepEqual(geoRepository.calls.filter((c) => c.name === 'findNearbyPlaces').pop().args.categories, ['atm', 'bank'], 'an ATM search also finds banks');
    assert.equal(atm.status, 200);
    const cafes = await local.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=fuel&lang=ar`);
    assert.equal(cafes.body.places[0].name, 'وقود الاختبار', 'the Arabic name when Arabic is asked for');
    const none = await local.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=hotel`);
    assert.deepEqual(none.body.places, [], 'no hotel nearby is an empty list');
    const bad = await local.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=casino`);
    assert.equal(bad.status, 400);
  } finally { await local.close(); }
});

// --------------------------------------------------------------------- routes

test('POST /routes: real route types as alternatives, ranked by live AI delay, with alerts and steps', async () => {
  ingestHeavyNorth(api.engine);
  const before = providers.count('/v1/routing');
  const r = await api.post('/api/v1/routes', {
    start: START, destination: DESTINATION, maxRoutes: 4, steps: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { routes } = r.body;
  assert.equal(routes.length, 2, 'balanced and short; the third type returned the same road a few metres aside and was dropped as a copy');
  const sent = providers.calls.filter((c) => c.path === '/v1/routing').slice(before);
  assert.deepEqual(sent.map((c) => c.query.type).sort(), ['balanced', 'less_maneuvers', 'short'], 'one request per route type');
  assert.ok(sent.every((c) => c.apiKey === TEST_KEY && c.query.apiKey === undefined && c.query.mode === 'drive'));
  assert.equal(sent[0].query.waypoints, `${START.lat},${START.lng}|${DESTINATION.lat},${DESTINATION.lng}`, 'lat,lng order');
  assert.equal(r.body.trafficStatus, 'included');
  assert.equal(r.body.roadAlertsStatus, 'unavailable', 'no database');
  assert.deepEqual(r.body.snapWarnings, []);

  // Through: 600 s + 80 s live delay = 680 s. Bypass: 640 s, no monitored intersection.
  const [best, second] = routes;
  assert.deepEqual(routes.map((x) => x.rank), [1, 2]);
  assert.equal(best.duration, 640);
  assert.equal(best.traffic.basis, 'none');
  assert.equal(best.traffic.adjustedDuration, 640);
  assert.equal(second.duration, 600);
  assert.equal(second.traffic.basis, 'live-ai');
  assert.equal(second.traffic.delay, 80);
  assert.equal(second.traffic.adjustedDuration, 680);
  assert.ok(Date.parse(second.traffic.updatedAt));
  assert.deepEqual(second.traffic.intersections.map((i) => [i.id, i.approach, i.included]), [['main', 'north', true]]);
  assert.equal(second.traffic.alerts[0].type, 'long_queue');
  assert.equal(second.traffic.intersections.some((i) => i.id === 'north-gate'), false, 'an intersection without a position is not matched');

  assert.equal(best.geometry.type, 'LineString', 'the provider MultiLineString is joined into the API LineString');
  assert.equal(best.geometry.coordinates[0].length, 2);
  assert.match(best.id, /^rt_/);
  assert.equal(second.steps[0].maneuver.type, 'depart');
  assert.equal(second.steps[1].instruction, 'Turn left onto Cross Street.');
  assert.deepEqual([second.steps[1].maneuver.type, second.steps[1].maneuver.modifier], ['turn', 'left']);
  assert.equal(second.steps[1].maneuver.location.length, 2);
  assert.equal(second.steps.at(-1).maneuver.type, 'arrive');
  assert.match(r.body.attribution.text, /Powered by Geoapify/);

  // Same request again: routes from the cache, traffic recomputed, same ids.
  const calls = providers.count('/v1/routing');
  const again = await api.post('/api/v1/routes', { start: START, destination: DESTINATION, maxRoutes: 4 });
  assert.equal(again.body.cached, true);
  assert.equal(providers.count('/v1/routing'), calls, 'no new provider request');
  assert.deepEqual(again.body.routes.map((x) => x.id), routes.map((x) => x.id));
  assert.equal(again.body.routes[0].steps, undefined, 'steps only when asked for');

  const single = await api.post('/api/v1/routes', { start: { lat: START.lat + 0.001, lng: START.lng }, destination: DESTINATION, maxRoutes: 1 });
  assert.equal(single.body.routes.length, 1);
  assert.equal(providers.count('/v1/routing') - calls, 1, 'maxRoutes 1 costs one provider request');
});

test('POST /routes with your own OSRM: alternatives from one request, snap warnings', async () => {
  const own = await startApi({ providers: providers.url, overrides: { routing: { osrmUrl: `${providers.url}/osrm` } } });
  try {
    const before = providers.count('/v1/routing');
    const r = await own.post('/api/v1/routes', { start: START, destination: DESTINATION, maxRoutes: 3, steps: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.routes.length, 2);
    assert.equal(providers.calls.filter((c) => c.path.startsWith('/osrm/')).pop().query.alternatives, '2');
    assert.equal(providers.count('/v1/routing'), before, 'Geoapify is not asked when an OSRM is configured');
    assert.equal(r.body.snapWarnings.length, 1);
    assert.match(r.body.snapWarnings[0], /Destination is 4\d\d m/);
    assert.equal(own.navigation.health().osrm.enabled, true);
    assert.equal((await own.get('/api/v1/config')).body.features.routing.provider, 'osrm');
    const sea = await own.post('/api/v1/routes', { start: { lat: 10, lng: 45 }, destination: { lat: 10.01, lng: 45 } });
    assert.equal(sea.body.code, 'POINT_NOT_ROUTABLE');
  } finally { await own.close(); }
});

test('POST /routes maps provider failures to stable codes', async () => {
  const at = (lat) => ({ start: { lat, lng: 45 }, destination: { lat: lat + 0.01, lng: 45 } });
  const cases = [
    // Our key being refused (15) is not a provider fault, so it also breaks the run of faults before the breaker opens.
    [10, 422, 'POINT_NOT_ROUTABLE'], [11, 422, 'NO_ROUTE'], [12, 502, 'PROVIDER_ERROR'], [13, 504, 'PROVIDER_TIMEOUT'],
    [15, 502, 'PROVIDER_AUTH_FAILED'], [14, 503, 'PROVIDER_BUSY'],
  ];
  for (const [lat, status, code] of cases) {
    const r = await api.post('/api/v1/routes', at(lat));
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
    assert.equal(r.body.ok, false);
    assert.doesNotMatch(r.body.error, new RegExp(`127\\.0\\.0\\.1|${TEST_KEY}|Invalid apiKey`), 'provider URLs, keys and provider text are not leaked');
  }
  const busy = await api.post('/api/v1/routes', at(14));
  assert.equal(busy.headers.get('retry-after'), '2', 'the provider Retry-After is passed on');
  const notJson = await api.call('POST', '/api/v1/routes', { body: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(notJson.status, 415);
  assert.equal(notJson.body.code, 'UNSUPPORTED_MEDIA_TYPE');
  const invalid = await api.post('/api/v1/routes', { start: START });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.details.join(), /destination/);
});

test('the daily budget of routing-provider credits stops requests before the provider is asked; cached routes are free', async () => {
  const route = { start: START, destination: DESTINATION };
  const small = await startApi({ providers: providers.url, overrides: { geoapify: { dailyLimit: 1 } } });
  try {
    // One credit buys one provider request: the first route type is asked, the alternatives are refused.
    const first = await small.post('/api/v1/routes', route);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.routes.length, 1);
    assert.equal(small.navigation.health().geoapify.dailyBudget.usedToday, 1);
    const sent = providers.count('/v1/routing');
    const over = await small.post('/api/v1/routes', { start: START, destination: latLng(300, -800) });
    assert.equal(over.status, 503, JSON.stringify(over.body));
    assert.equal(over.body.code, 'PROVIDER_QUOTA_EXCEEDED');
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    assert.equal(providers.count('/v1/routing'), sent, 'nothing was sent over budget');
  } finally { await small.close(); }

  const roomy = await startApi({ providers: providers.url, overrides: { geoapify: { dailyLimit: 1000 } } });
  try {
    assert.equal((await roomy.post('/api/v1/routes', route)).status, 200);
    const used = roomy.navigation.health().geoapify.dailyBudget.usedToday;
    assert.ok(used > 0, 'a route costs credits');
    const sent = providers.count('/v1/routing');
    assert.equal((await roomy.post('/api/v1/routes', route)).status, 200);
    assert.equal(providers.count('/v1/routing'), sent, 'the same route is cached: no request');
    assert.equal(roomy.navigation.health().geoapify.dailyBudget.usedToday, used, 'and no credit');
  } finally { await roomy.close(); }
});

test('a provider that keeps failing is benched: requests fail fast with 503 PROVIDER_BUSY', async () => {
  const flaky = await startApi({ providers: providers.url, overrides: { providerCooldownMs: 60_000 } });
  try {
    const hang = { start: { lat: 13, lng: 45 }, destination: { lat: 13.01, lng: 45 } };
    for (let i = 0; i < 3; i += 1) assert.equal((await flaky.post('/api/v1/routes', hang)).body.code, 'PROVIDER_TIMEOUT');
    const started = Date.now();
    const benched = await flaky.post('/api/v1/routes', { start: START, destination: DESTINATION });
    assert.equal(benched.status, 503);
    assert.equal(benched.body.code, 'PROVIDER_BUSY');
    assert.ok(Number(benched.headers.get('retry-after')) > 0);
    assert.ok(Date.now() - started < 400, 'no wait for another timeout');
    assert.equal(flaky.navigation.health().geoapify.circuit, 'open');
  } finally { await flaky.close(); }
});

// -------------------------------------------------------------------- traffic

test('GET /traffic reports live and no-data intersections; bbox filters', async () => {
  ingestHeavyNorth(api.engine);
  const r = await api.get('/api/v1/traffic');
  assert.equal(r.status, 200);
  const main = r.body.intersections.find((i) => i.id === 'main');
  const gate = r.body.intersections.find((i) => i.id === 'north-gate');
  assert.equal(main.status, 'live');
  assert.equal(main.approaches.north.estimatedDelaySeconds, 80);
  assert.equal(main.approaches.north.level, 'moderate');
  assert.equal(main.approaches.west.available, false);
  assert.equal(main.approaches.west.vehicles, null);
  assert.equal(gate.status, 'no-data');
  assert.equal(gate.approaches, null);
  assert.equal(gate.positionSource, 'unknown');
  assert.equal(gate.lat, null, 'no invented coordinates');

  const box = latLng(-100, -100);
  const box2 = latLng(100, 100);
  const filtered = await api.get(`/api/v1/traffic?south=${box.lat}&west=${box.lng}&north=${box2.lat}&east=${box2.lng}`);
  assert.deepEqual(filtered.body.intersections.map((i) => i.id), ['main']);
  assert.equal((await api.get('/api/v1/traffic?south=1')).status, 400);
});

test('live traffic never includes simulated snapshots', () => {
  const snap = (dataMode, id) => ({ dataMode, intersectionId: id, name: id, lat: 1, lng: 1, aiStatus: 'WAITING', lastUpdate: null });
  const engine = { getAllSnapshots: () => [snap('live', 'real'), snap('simulation', 'fake')], ids: () => ['real'] };
  const live = createLiveTrafficService({ engine, config: api.config.navigation.traffic });
  assert.deepEqual(live.list().intersections.map((i) => i.id), ['real']);
});

// --------------------------------------------------------- road data, no database

test('GET /road-features without a database: 503 DATABASE_UNAVAILABLE, never invented features', async () => {
  const a = latLng(-500, -500);
  const b = latLng(500, 500);
  const q = `south=${a.lat}&west=${a.lng}&north=${b.lat}&east=${b.lng}`;
  const r = await api.get(`/api/v1/road-features?${q}`);
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'DATABASE_UNAVAILABLE');
  assert.equal(r.body.features, undefined);
  assert.equal((await api.get('/api/v1/road-features?south=1&west=1&north=2&east=2&kinds=volcano')).status, 400);
});

test('reports without a database: 503 DATABASE_UNAVAILABLE; writes need a device token first', async () => {
  const q = 'south=35.5&west=45.4&north=35.6&east=45.5';
  const list = await api.get(`/api/v1/reports?${q}`);
  assert.equal(list.status, 503);
  assert.equal(list.body.code, 'DATABASE_UNAVAILABLE');

  const body = { type: 'accident', lat: IX.lat, lng: IX.lng };
  const anonymous = await api.post('/api/v1/reports', body);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, 'DEVICE_TOKEN_REQUIRED');
  assert.match(anonymous.headers.get('www-authenticate'), /Bearer/);
  const token = await api.deviceToken();
  const withToken = await api.post('/api/v1/reports', body, { token });
  assert.equal(withToken.status, 503);
  assert.equal(withToken.body.code, 'DATABASE_UNAVAILABLE');
  assert.equal((await api.get('/api/v1/reports/not-an-id')).status, 400);
});

test('admin endpoints need NAV_ADMIN_TOKEN and are disabled without it', async () => {
  const body = { kind: 'speed_camera', lat: IX.lat, lng: IX.lng };
  const none = await api.post('/api/v1/road-features', body);
  assert.equal(none.status, 401);
  assert.equal(none.body.code, 'ADMIN_TOKEN_INVALID');
  const deviceToken = await api.deviceToken();
  assert.equal((await api.post('/api/v1/road-features', body, { token: deviceToken })).status, 401, 'a device token is not an admin token');
  const admin = await api.post('/api/v1/road-features', body, { token: ADMIN_TOKEN });
  assert.equal(admin.status, 503, 'authorised, but no database');
  assert.equal(admin.body.code, 'DATABASE_UNAVAILABLE');

  const disabled = await startApi({ providers: providers.url, overrides: { adminToken: '' } });
  try {
    const r = await disabled.patch('/api/v1/reports/0123456789abcdef01234567', { status: 'removed' }, { token: ADMIN_TOKEN });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'FEATURE_DISABLED');
  } finally { await disabled.close(); }
});

test('admin console endpoints: admin token only; without a database the sections say unavailable', async () => {
  const device = await api.deviceToken();
  for (const p of ['overview', 'users', 'reports', 'road-features']) {
    assert.equal((await api.get(`/api/v1/admin/${p}`)).status, 401, `${p} without a token`);
    assert.equal((await api.get(`/api/v1/admin/${p}`, { token: device })).status, 401, `${p} with a device token`);
  }
  const overview = await api.get('/api/v1/admin/overview', { token: ADMIN_TOKEN });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.users.available, false);
  assert.equal(overview.body.reports.available, false);
  assert.equal(overview.body.roadFeatures.available, false);
  assert.equal(overview.body.traffic.monitoredIntersections, 2);
  assert.equal(overview.body.system.geoapify.enabled, true);
  assert.equal(JSON.stringify(overview.body).includes(TEST_KEY), false, 'no key in the overview');
  assert.equal((await api.get('/api/v1/admin/users', { token: ADMIN_TOKEN })).body.code, 'DATABASE_UNAVAILABLE');
  assert.equal((await api.get('/api/v1/admin/users?q=%24ne', { token: ADMIN_TOKEN })).status, 400);
  assert.equal((await api.get('/api/v1/admin/reports?status=nope', { token: ADMIN_TOKEN })).status, 400);
  assert.equal((await api.get('/api/v1/admin/road-features?limit=0', { token: ADMIN_TOKEN })).status, 400);
});

// ------------------------------------------------------------ limits + disabled

test('rate limits answer 429 RATE_LIMITED with Retry-After and RateLimit headers', async () => {
  const limited = await startApi({ providers: providers.url, overrides: { rateLimits: { routesPerMinute: 2 } } });
  try {
    const body = { start: START, destination: DESTINATION };
    assert.equal((await limited.post('/api/v1/routes', body)).status, 200);
    const second = await limited.post('/api/v1/routes', body);
    assert.equal(second.headers.get('ratelimit-remaining'), '0');
    const third = await limited.post('/api/v1/routes', body);
    assert.equal(third.status, 429);
    assert.equal(third.body.code, 'RATE_LIMITED');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal((await limited.get('/api/v1/traffic')).status, 200, 'other routes are not affected');
  } finally { await limited.close(); }
});

test('disabled providers answer 503 FEATURE_DISABLED', async () => {
  const off = await startApi({
    providers: providers.url,
    overrides: { geoapify: { apiKey: '' } },
    geoEnabled: false, // no DATABASE_URL
  });
  try {
    const route = await off.post('/api/v1/routes', { start: START, destination: DESTINATION });
    assert.equal(route.status, 503);
    assert.equal(route.body.code, 'FEATURE_DISABLED');
    assert.equal((await off.get('/api/v1/places/search?q=hospital')).body.code, 'FEATURE_DISABLED');
    assert.equal((await off.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=fuel`)).body.code, 'FEATURE_DISABLED');
    const config = await off.get('/api/v1/config');
    assert.equal(config.body.features.routing.available, false);
    assert.equal(config.body.features.placeSearch.available, false);
  } finally { await off.close(); }
});

test('unknown /api/v1 routes answer 404 NOT_FOUND in the API error shape', async () => {
  const r = await api.get('/api/v1/nowhere');
  assert.equal(r.status, 404);
  assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error', 'ok']);
  assert.equal(r.body.code, 'NOT_FOUND');
});

// -------------------------------------------------------------------- swagger

test('Swagger documents every /api/v1 route, with valid references, security and examples', () => {
  const handler = () => {};
  const controller = new Proxy({}, { get: () => handler });
  const router = createNavigationRoutes({
    navigationController: controller,
    roadDataController: controller,
    authController: controller,
    adminController: controller,
    placeDataController: controller,
    deviceTokens: { verify: () => ({ ok: false }) },
    userTokens: { verify: () => ({ ok: false }) },
    adminToken: 'x',
    rateLimits: api.config.navigation.rateLimits,
  });
  const documented = new Set();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = `/api/v1${layer.route.path.replace(/:([A-Za-z]+)/g, '{$1}')}`;
    for (const method of Object.keys(layer.route.methods)) {
      assert.ok(spec.paths[path] && spec.paths[path][method], `${method.toUpperCase()} ${path} is documented`);
      documented.add(`${method} ${path}`);
    }
  }
  const v1Operations = Object.entries(spec.paths).filter(([p]) => p.startsWith('/api/v1'))
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`));
  assert.deepEqual(v1Operations.sort(), [...documented].sort(), 'no documented route that does not exist');

  const schemes = spec.components.securitySchemes;
  (function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string') assert.ok(spec.components.schemas[value.$ref.split('/').pop()], value.$ref);
    if (Array.isArray(value.security)) {
      for (const requirement of value.security) for (const name of Object.keys(requirement)) assert.ok(schemes[name], `security scheme ${name}`);
    }
    for (const child of Object.values(value)) walk(child);
  }(spec));

  const examples = (path, method) => Object.values(spec.paths[path][method].requestBody.content['application/json'].examples).map((e) => e.value);
  for (const e of examples('/api/v1/routes', 'post')) assert.ok(validateRouteRequest(e, { maxRoutes: 4 }).value, 'route example is valid');
  for (const e of examples('/api/v1/reports', 'post')) assert.ok(validateReportInput(e).value, 'report example is valid');
  for (const e of examples('/api/v1/road-features', 'post')) assert.ok(validateFeatureInput(e).value, 'feature example is valid');
});
