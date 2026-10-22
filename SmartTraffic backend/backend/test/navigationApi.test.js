// Mobile navigation API (/api/v1) over HTTP: real router, controllers,
// services, validation and decision engine on an ephemeral port. Providers
// are a local fake (test/helpers/navigationHarness.js) reached over real
// HTTP. No database here (reports and operator features answer 503);
// test/navigationDatabase.test.js covers them against a real MongoDB.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADMIN_TOKEN, START, DESTINATION, IX, latLng, startFakeProviders, startApi, ingestHeavyNorth,
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
  assert.equal(r.body.attribution[0].text, '© OpenStreetMap contributors');
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

test('GET /places/search: near the user first, then everywhere; cached; identifying User-Agent', async () => {
  const before = providers.count('/nominatim/search');
  const r = await api.get(`/api/v1/places/search?q=far%20away&lat=${IX.lat}&lng=${IX.lng}&lang=en`);
  assert.equal(r.status, 200);
  assert.equal(r.body.scope, 'global', 'nothing in the local box, so the unbounded search answered');
  assert.equal(r.body.places[0].name, 'far away result');
  assert.equal(r.body.places[0].id, 'osm:node:42');
  assert.equal(r.body.places[0].addressDetails.city, 'Test City');
  assert.equal(providers.count('/nominatim/search') - before, 2);
  const [local, global] = providers.calls.filter((c) => c.path === '/nominatim/search').slice(-2);
  assert.equal(local.query.bounded, '1');
  assert.equal(global.query.bounded, undefined);
  assert.equal(local.query['accept-language'], 'en');
  assert.equal(local.query.email, 'tests@example.invalid');
  assert.match(local.userAgent, /^SmartTraffic-Navigation\//);

  const cached = await api.get(`/api/v1/places/search?q=far%20away&lat=${IX.lat}&lng=${IX.lng}&lang=en`);
  assert.equal(cached.body.cached, true);
  assert.equal(providers.count('/nominatim/search') - before, 2, 'served from the cache');

  const local2 = await api.get(`/api/v1/places/search?q=hospital&lat=${IX.lat}&lng=${IX.lng}`);
  assert.equal(local2.body.scope, 'local');
  const none = await api.get('/api/v1/places/search?q=nothing%20here');
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.places, []);

  const short = await api.get('/api/v1/places/search?q=ab');
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'INVALID_REQUEST');
  assert.ok(short.body.details.length);
});

test('GET /places/reverse returns the address, or null where there is none', async () => {
  const r = await api.get(`/api/v1/places/reverse?lat=${IX.lat}&lng=${IX.lng}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.place.address, 'Main Street, Test City');
  const none = await api.get('/api/v1/places/reverse?lat=1.5&lng=1.5');
  assert.equal(none.body.place, null);
  assert.equal((await api.get('/api/v1/places/reverse?lat=95&lng=1')).status, 400);
});

test('GET /places/nearby: nearest first, inside the radius, next Overpass instance on failure', async () => {
  const r = await api.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=fuel&radius=1000`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.places.map((p) => p.name), ['Near Fuel', 'Far Fuel']);
  assert.ok(r.body.places[0].distanceMeters < r.body.places[1].distanceMeters);
  assert.equal(r.body.places[0].details.openingHours, '24/7');
  const downCalls = providers.count('/overpass-down');
  assert.ok(downCalls >= 1, 'first instance tried');
  await api.get(`/api/v1/places/nearby?lat=${IX.lat + 0.01}&lng=${IX.lng}&category=fuel`);
  assert.equal(providers.count('/overpass-down'), downCalls, 'the failed instance is benched for the cooldown');
  assert.equal(api.navigation.health().overpass.benchedInstances, 1);
  const bad = await api.get(`/api/v1/places/nearby?lat=${IX.lat}&lng=${IX.lng}&category=casino`);
  assert.equal(bad.status, 400);
});

// --------------------------------------------------------------------- routes

test('POST /routes ranks routes by live AI delay, with alerts, alternatives and steps', async () => {
  ingestHeavyNorth(api.engine);
  const r = await api.post('/api/v1/routes', {
    start: START, destination: DESTINATION, maxRoutes: 4, steps: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { routes } = r.body;
  assert.equal(routes.length, 3, 'two from OSRM + one via-point alternative (the duplicate was rejected)');
  assert.equal(r.body.trafficStatus, 'included');
  assert.equal(r.body.roadAlertsStatus, 'unavailable', 'no database');
  assert.equal(r.body.snapWarnings.length, 1);
  assert.match(r.body.snapWarnings[0], /Destination is 450 m/);

  // Through: 600 s + 80 s live delay = 680 s. Bypass: 640 s, no monitored intersection.
  const [best, second, third] = routes;
  assert.deepEqual(routes.map((x) => x.rank), [1, 2, 3]);
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
  assert.equal(third.duration, 900);
  assert.equal(second.traffic.intersections.some((i) => i.id === 'north-gate'), false, 'placeholder position not matched');

  assert.equal(best.geometry.type, 'LineString');
  assert.equal(best.geometry.coordinates[0].length, 2);
  assert.match(best.id, /^rt_/);
  assert.equal(best.steps[0].maneuver.type, 'depart');
  assert.equal(best.steps[1].instruction, 'Turn left onto Cross Street');
  assert.equal(r.body.attribution.text, '© OpenStreetMap contributors');

  // Same request again: routes from the cache, traffic recomputed, same ids.
  const osrmCalls = providers.count('/osrm/');
  const again = await api.post('/api/v1/routes', { start: START, destination: DESTINATION, maxRoutes: 4 });
  assert.equal(again.body.cached, true);
  assert.equal(providers.count('/osrm/'), osrmCalls, 'no new provider request');
  assert.deepEqual(again.body.routes.map((x) => x.id), routes.map((x) => x.id));
  assert.equal(again.body.routes[0].steps, undefined, 'steps only when asked for');
});

test('POST /routes maps provider failures to stable codes', async () => {
  const at = (lat) => ({ start: { lat, lng: 45 }, destination: { lat: lat + 0.01, lng: 45 } });
  const cases = [[10, 422, 'POINT_NOT_ROUTABLE'], [11, 422, 'NO_ROUTE'], [12, 502, 'PROVIDER_ERROR'], [13, 504, 'PROVIDER_TIMEOUT']];
  for (const [lat, status, code] of cases) {
    const r = await api.post('/api/v1/routes', at(lat));
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code);
    assert.equal(r.body.ok, false);
    assert.doesNotMatch(r.body.error, /127\.0\.0\.1/, 'provider URLs are not leaked');
  }
  const notJson = await api.call('POST', '/api/v1/routes', { body: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(notJson.status, 415);
  assert.equal(notJson.body.code, 'UNSUPPORTED_MEDIA_TYPE');
  const invalid = await api.post('/api/v1/routes', { start: START });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.details.join(), /destination/);
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
    assert.equal(flaky.navigation.health().routing.circuit, 'open');
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
  assert.equal(gate.positionSource, 'placeholder');

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

test('GET /road-features without a database: OSM only, the operator source reported unavailable', async () => {
  const a = latLng(-500, -500);
  const b = latLng(500, 500);
  const q = `south=${a.lat}&west=${a.lng}&north=${b.lat}&east=${b.lng}`;
  const r = await api.get(`/api/v1/road-features?${q}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sources, { operator: 'unavailable', osm: 'ok' });
  assert.deepEqual(r.body.features.map((f) => f.kind).sort(), ['speed_bump', 'speed_camera']);
  assert.equal(r.body.features.find((f) => f.kind === 'speed_camera').speedLimitKmh, 60);
  assert.equal(r.body.attribution.text, '© OpenStreetMap contributors');

  const overpassCalls = providers.count('/overpass');
  await api.get(`/api/v1/road-features?${q}&kinds=speed_camera`);
  assert.equal(providers.count('/overpass'), overpassCalls, 'tiles served from the cache');

  const closures = await api.get(`/api/v1/road-features?${q}&kinds=road_closure`);
  assert.equal(closures.status, 503, 'the only source that has closures is down');
  assert.equal(closures.body.code, 'SERVICE_UNAVAILABLE');
  assert.equal(closures.body.sources.osm, 'not-requested');
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
    overrides: { routing: { url: null }, geocoding: { url: null }, overpass: { urls: [] } },
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
    deviceTokens: { verify: () => ({ ok: false }) },
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
