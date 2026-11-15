// Mobile navigation API (/api/v1): pure logic, no network and no database.
const test = require('node:test');
const assert = require('node:assert/strict');

const geo = require('../utils/geo');
const { createDeviceTokens } = require('../utils/deviceToken');
const { createRateLimiter } = require('../utils/rateLimit');
const { TtlCache } = require('../utils/ttlCache');
const {
  createThrottle, requestJson, createCircuitBreaker, UpstreamError,
} = require('../utils/upstream');
const { corsOrigin } = require('../utils/cors');
const v = require('../utils/navValidation');
const {
  instructionFor, routeSteps, normalizeRoute, routeId, normalizeGeoapifyRoute, geoapifyManeuver, isSameRoad,
} = require('../services/navigation/routingService');
const { toPlace, toNearbyPlace, preferredLang, pickName } = require('../services/navigation/placeService');
const { createGeoapifyClient, createOsrmClient, geoapifyError, osrmError } = require('../services/navigation/providerClient');
const { fixture } = require('./helpers/navigationHarness');
const {
  intersectionView, approachDirection, estimateRoute, trafficStatus,
} = require('../services/navigation/liveTrafficService');

const quiet = { warn() {}, error() {}, log() {} };

// Local grid around a monitored intersection: x metres east, y metres north -> [lng, lat].
const IX = { lat: 35.5617, lng: 45.4329 };
const M_LAT = 1 / 110540;
const M_LNG = 1 / (111320 * Math.cos((IX.lat * Math.PI) / 180));
const at = (x, y) => [IX.lng + x * M_LNG, IX.lat + y * M_LAT];
const line = (...points) => points.map(([x, y]) => at(x, y));

// ------------------------------------------------------------------- geometry

test('locateOnLine gives the distance to the line and the distance along it', () => {
  const l = line([0, 0], [1000, 0]); // 1 km eastwards
  const p = { lat: IX.lat + 50 * M_LAT, lng: IX.lng + 400 * M_LNG }; // 50 m north of the 400 m mark
  const r = geo.locateOnLine(p, l);
  assert.ok(Math.abs(r.distanceMeters - 50) < 1, `distance ${r.distanceMeters}`);
  assert.ok(Math.abs(r.alongMeters - 400) < 3, `along ${r.alongMeters}`);
  assert.equal(geo.locateOnLine(p, []).distanceMeters, Infinity);
});

test('bbox helpers: padding, containment and the GeoJSON polygon', () => {
  const b = geo.bboxOfLines([line([0, 0], [1000, 500])]);
  const padded = geo.padBBoxMeters(b, 100);
  assert.ok(padded.south < b.south && padded.north > b.north && padded.west < b.west && padded.east > b.east);
  assert.ok(geo.bboxContainsPoint(padded, IX));
  const poly = geo.bboxPolygon(b);
  assert.equal(poly.type, 'Polygon');
  assert.deepEqual(poly.coordinates[0][0], poly.coordinates[0][4], 'closed ring');
});

// --------------------------------------------------------------- device tokens

test('device tokens: issue, verify, and refuse tampered, foreign, unsigned or expired tokens', () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const tokens = createDeviceTokens({ secret: 'x'.repeat(40), ttlSeconds: 3600, now: () => t, log: quiet });
  const issued = tokens.issue({ platform: 'android' });
  const ok = tokens.verify(issued.token);
  assert.equal(ok.ok, true);
  assert.equal(ok.device.id, issued.deviceId);
  assert.equal(ok.device.platform, 'android');
  assert.match(issued.deviceId, /^[0-9a-f-]{36}$/);

  const [h, p, s] = issued.token.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: '00000000-0000-4000-8000-000000000000' })).toString('base64url');
  assert.deepEqual(tokens.verify(`${h}.${forged}.${s}`), { ok: false, reason: 'invalid' }, 'payload changed');
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(tokens.verify(`${none}.${p}.`).ok, false, 'alg none');
  assert.equal(tokens.verify(`${none}.${p}.${s}`).ok, false, 'alg none with a signature');
  const other = createDeviceTokens({ secret: 'y'.repeat(40), now: () => t, log: quiet });
  assert.equal(other.verify(issued.token).ok, false, 'signed with another secret');
  for (const junk of ['', 'a.b', 'a.b.c', null, 42, 'x'.repeat(3000)]) assert.equal(tokens.verify(junk).ok, false);

  t += 3601 * 1000;
  assert.deepEqual(tokens.verify(issued.token), { ok: false, reason: 'expired' });
});

test('device tokens: renewal keeps the device id; an unset secret is per process', () => {
  let t = Date.now();
  const warnings = [];
  const tokens = createDeviceTokens({ ttlSeconds: 30 * 86400, now: () => t, log: { warn: (m) => warnings.push(m) } });
  assert.equal(tokens.ephemeral, true);
  assert.match(warnings[0], /DEVICE_TOKEN_SECRET is not set/);
  const first = tokens.issue();
  const device = tokens.verify(first.token).device;
  assert.equal(tokens.shouldRenew(device), false);
  t += 24 * 86400 * 1000; // 6 days left
  assert.equal(tokens.shouldRenew(tokens.verify(first.token).device), true);
  const renewed = tokens.issue({ deviceId: device.id });
  assert.equal(renewed.deviceId, first.deviceId);
});

// -------------------------------------------------------- rate limit, cache, throttle

function fakeRes() {
  return {
    headers: {}, statusCode: 200, body: null,
    set(k, val) { this.headers[k] = val; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('rate limiter: max per window per key, then 429 RATE_LIMITED with Retry-After', () => {
  let t = 0;
  const limiter = createRateLimiter({ name: 'test', windowMs: 60_000, max: 2, now: () => t });
  const call = (ip) => {
    const res = fakeRes();
    let passed = false;
    limiter({ ip }, res, () => { passed = true; });
    return { res, passed };
  };
  assert.equal(call('a').passed, true);
  assert.equal(call('a').passed, true);
  const third = call('a');
  assert.equal(third.passed, false);
  assert.equal(third.res.statusCode, 429);
  assert.equal(third.res.body.code, 'RATE_LIMITED');
  assert.equal(third.res.headers['Retry-After'], '60');
  assert.equal(call('b').passed, true, 'keys are independent');
  t = 60_001;
  assert.equal(call('a').passed, true, 'new window');
});

test('TTL cache expires entries and evicts the least recently used', () => {
  let t = 0;
  const cache = new TtlCache({ maxEntries: 2, ttlMs: 100, now: () => t });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // a is now most recent
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined, 'b evicted');
  assert.equal(cache.get('a'), 1);
  t = 101;
  assert.equal(cache.get('a'), undefined, 'expired');
});

test('throttle spaces request starts and refuses when the queue is too long', async () => {
  const starts = [];
  const throttle = createThrottle({ minIntervalMs: 40, maxWaitMs: 100, provider: 'test' });
  const task = () => { starts.push(Date.now()); return Promise.resolve(starts.length); };
  const results = await Promise.all([throttle.schedule(task), throttle.schedule(task), throttle.schedule(task)]);
  assert.deepEqual(results, [1, 2, 3]);
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 35, `gap ${starts[i] - starts[i - 1]}`);

  const busy = createThrottle({ minIntervalMs: 1000, maxWaitMs: 1500, provider: 'test' });
  const slow = () => new Promise((r) => { setTimeout(r, 1); });
  const first = busy.schedule(slow);
  const second = busy.schedule(slow);
  await assert.rejects(busy.schedule(slow), (e) => e.code === 'PROVIDER_BUSY' && e.retryAfterSeconds >= 2);
  await Promise.all([first, second]);

  const open = createThrottle({ minIntervalMs: 0 });
  assert.equal(await open.schedule(() => Promise.resolve('now')), 'now');
});

test('requestJson maps timeouts, unreachable hosts and 429 to stable codes', async () => {
  const hang = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(requestJson('http://x', { provider: 'P', timeoutMs: 20, fetchImpl: hang }), (e) => e.code === 'PROVIDER_TIMEOUT');
  await assert.rejects(requestJson('http://x', { provider: 'P', fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')) }), (e) => e.code === 'PROVIDER_UNREACHABLE');
  const limited = () => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }));
  await assert.rejects(requestJson('http://x', { provider: 'P', fetchImpl: limited }), (e) => e.code === 'PROVIDER_BUSY' && e.retryAfterSeconds === 7);
  const quota = await requestJson('http://x', { provider: 'P', fetchImpl: limited, passRateLimit: true });
  assert.equal(quota.status, 429, 'passRateLimit hands the 429 body to the caller');
  const html = () => Promise.resolve(new Response('<html>', { status: 502 }));
  await assert.rejects(requestJson('http://x', { provider: 'P', fetchImpl: html }), (e) => e.code === 'PROVIDER_ERROR' && !/http:\/\/x/.test(e.message));
  let sentUA = null;
  const echo = (url, init) => { sentUA = init.headers['User-Agent']; return Promise.resolve(Response.json({ a: 1 }, { status: 400 })); };
  assert.deepEqual((await requestJson('http://x', { provider: 'P', userAgent: 'UA/1', fetchImpl: echo })).json, { a: 1 });
  assert.equal(sentUA, 'UA/1');
});

test('circuit breaker opens after repeated provider faults, fails fast, and closes after the cooldown', () => {
  let t = 0;
  const breaker = createCircuitBreaker({
    provider: 'P', failureThreshold: 2, cooldownMs: 30_000, now: () => t,
  });
  const timeout = new UpstreamError('PROVIDER_TIMEOUT', 'slow');
  breaker.failure(new UpstreamError('PROVIDER_ERROR', 'bad request', { status: 400 })); // our fault, not the provider's
  breaker.failure(new UpstreamError('PROVIDER_BUSY', 'local queue full')); // no status: our own queue
  breaker.failure(timeout);
  assert.equal(breaker.open, false, 'one provider fault so far');
  breaker.failure(timeout);
  assert.equal(breaker.open, true);
  assert.throws(() => breaker.check(), (e) => e.code === 'PROVIDER_BUSY' && e.retryAfterSeconds === 30);
  assert.equal(breaker.state().circuit, 'open');
  t = 30_001;
  assert.doesNotThrow(() => breaker.check());
  breaker.failure(timeout);
  breaker.success();
  breaker.failure(timeout);
  assert.equal(breaker.open, false, 'a success resets the count');
});

// ------------------------------------------------------------------ validation

test('bbox validation: complete, ordered, not across the antimeridian, bounded span', () => {
  assert.deepEqual(v.parseBBox({ south: '35.5', west: '45.4', north: '35.6', east: '45.5' }).value, { south: 35.5, west: 45.4, north: 35.6, east: 45.5 });
  assert.match(v.parseBBox({ south: '35.5' }).errors.join(), /west is required/);
  assert.match(v.parseBBox({ south: '35.6', west: '45.4', north: '35.5', east: '45.5' }).errors.join(), /south must be less than north/);
  assert.match(v.parseBBox({ south: '1', west: '179', north: '2', east: '-179' }).errors.join(), /antimeridian/);
  assert.match(v.parseBBox({ south: '30', west: '40', north: '35', east: '45' }).errors.join(), /zoom in/);
  assert.match(v.parseBBox({ south: 'x', west: '1', north: '2', east: '3' }).errors.join(), /south must be a number/);
  assert.deepEqual(v.parseBBox({}, { required: false }), { value: null });
});

test('report, vote, moderation and feature validation', () => {
  const report = v.validateReportInput({ type: 'accident', lat: 35.5, lng: 45.4, heading: 90.04, description: '  Two  cars\nblocking ' });
  assert.deepEqual(report.value, { type: 'accident', lat: 35.5, lng: 45.4, heading: 90, description: 'Two cars blocking' });
  assert.ok(v.validateReportInput({ type: 'police', lat: 35.5, lng: 45.4 }).errors);
  assert.ok(v.validateReportInput({ type: 'hazard', lat: 95, lng: 45.4 }).errors);
  assert.ok(v.validateReportInput({ type: 'hazard', lat: 35, lng: 45, extra: 1 }).errors[0].includes('extra'));
  assert.ok(v.validateReportInput({ type: 'hazard', lat: 35, lng: 45, description: 'x'.repeat(281) }).errors);
  assert.deepEqual(v.validateVote({ vote: 'confirm' }).value, { vote: 'confirm' });
  assert.ok(v.validateVote({ vote: 'maybe' }).errors);
  assert.ok(v.validateModeration({}).errors[0].includes('nothing to change'));
  assert.ok(v.validateModeration({ status: 'dismissed' }).errors, 'moderators cannot set dismissed');

  const feature = v.validateFeatureInput({ kind: 'speed_camera', lat: 35.5, lng: 45.4, speedLimitKmh: 60, direction: 90 });
  assert.deepEqual(feature.value.location, { type: 'Point', coordinates: [45.4, 35.5] });
  assert.ok(v.validateFeatureInput({ kind: 'speed_camera', lat: 35.5 }).errors, 'lng missing');
  assert.ok(v.validateFeatureInput({ kind: 'road_closure', lat: 1, lng: 1, validFrom: '2026-02-01', validUntil: '2026-01-01' }).errors);
  assert.deepEqual(v.validateFeatureInput({ active: false }, { partial: true }).value, { active: false });
  assert.ok(v.validateFeatureInput({}, { partial: true }).errors);
});

test('route, search and language validation', () => {
  const ok = v.validateRouteRequest({ start: { lat: 35.5, lng: 45.4 }, destination: { lat: 35.6, lng: 45.5 } }, { maxRoutes: 4 });
  assert.deepEqual(ok.value, { start: { lat: 35.5, lng: 45.4 }, destination: { lat: 35.6, lng: 45.5 }, maxRoutes: 3, steps: false });
  assert.match(v.validateRouteRequest({ start: { lat: 35.5, lng: 45.4 }, destination: { lat: 35.5, lng: 45.4 } }, { maxRoutes: 4 }).errors.join(), /same point/);
  assert.ok(v.validateRouteRequest({ start: { lat: '35', lng: 45 }, destination: { lat: 35, lng: 45 } }, { maxRoutes: 4 }).errors);
  assert.ok(v.validateRouteRequest({ start: { lat: 35, lng: 45 }, destination: { lat: 36, lng: 45 }, maxRoutes: 5 }, { maxRoutes: 4 }).errors);
  assert.deepEqual(v.validateSearchQuery({ q: '  city   hospital ' }).value, { q: 'city hospital', near: null, limit: 5 });
  assert.ok(v.validateSearchQuery({ q: 'ab' }).errors);
  assert.ok(v.validateSearchQuery({ q: 'abc', lat: '35' }).errors, 'lat without lng');
  const req = (query, header) => ({ query, get: () => header });
  assert.deepEqual(v.parseLanguage(req({}, 'ar-IQ,ar;q=0.9,en;q=0.8')), { value: 'ar-IQ,ar,en' });
  assert.deepEqual(v.parseLanguage(req({ lang: 'ku' }, 'en')), { value: 'ku' });
  assert.ok(v.parseLanguage(req({ lang: 'en<script>' })).errors);
  assert.deepEqual(v.parseLanguage(req({}, '*')), { value: null }, 'odd headers are ignored, not refused');
});

// ------------------------------------------------------------------- providers

test('route steps: English instructions, and no arrive/depart at an internal via point', () => {
  assert.equal(instructionFor({ name: 'Salim St', maneuver: { type: 'turn', modifier: 'left' } }), 'Turn left onto Salim St');
  assert.equal(instructionFor({ name: '', maneuver: { type: 'turn', modifier: 'slight right' } }), 'Turn slightly right');
  assert.equal(instructionFor({ name: 'Ring Rd', maneuver: { type: 'roundabout', exit: 2 } }), 'At the roundabout, take the 2nd exit onto Ring Rd');
  assert.equal(instructionFor({ name: 'Ring Rd', maneuver: { type: 'roundabout', exit: 11 } }), 'At the roundabout, take the 11th exit onto Ring Rd');
  assert.equal(instructionFor({ name: 'Main', maneuver: { type: 'depart', bearing_after: 92 } }), 'Head east on Main');
  assert.equal(instructionFor({ maneuver: { type: 'arrive' } }), 'You have arrived at your destination');
  assert.equal(instructionFor({ name: 'A1', maneuver: { type: 'off ramp', modifier: 'sharp right' } }), 'Take the exit on the right onto A1');
  assert.equal(instructionFor({ name: 'X', maneuver: { type: 'fork', modifier: 'slight left' } }), 'Keep left at the fork onto X');

  const step = (type) => ({ distance: 10, duration: 2, name: 'R', maneuver: { type, location: [45, 35] } });
  const steps = routeSteps([{ steps: [step('depart'), step('turn'), step('arrive')] }, { steps: [step('depart'), step('turn'), step('arrive')] }]);
  assert.deepEqual(steps.map((s) => s.maneuver.type), ['depart', 'turn', 'turn', 'arrive']);
});

test('routes are normalised with a stable geometry-derived id', () => {
  const raw = {
    distance: 1234.56, duration: 200.04, geometry: { type: 'LineString', coordinates: line([0, 0], [500, 0]) },
    legs: [{ summary: 'Main Road, Ring Road', steps: [] }, { summary: 'Ring Road', steps: [] }],
  };
  const r = normalizeRoute(raw);
  assert.equal(r.summary, 'Main Road, Ring Road');
  assert.equal(r.distance, 1234.6);
  assert.equal(r.id, routeId(raw.geometry.coordinates));
  assert.match(r.id, /^rt_[0-9a-f]{12}$/);
  assert.equal(normalizeRoute({ ...raw, geometry: { type: 'Point', coordinates: [1, 2] } }), null);
  assert.equal(normalizeRoute({ ...raw, geometry: 'encoded-polyline' }), null, 'an encoded polyline is not GeoJSON: geometries=geojson is required');
});

test('Geoapify place answers become API places with local-script names; missing data stays null', () => {
  const search = fixture('search-hospital.json');
  const feature = search.features.find((f) => f.properties.other_names && f.properties.other_names['name:ku'] && f.properties.other_names['name:ar']);
  const props = feature.properties;
  const place = toPlace(feature, 'ku');
  assert.match(place.id, /^geoapify:/);
  assert.equal(place.name, props.other_names['name:ku']);
  assert.equal(toPlace(feature, 'ar').name, props.other_names['name:ar']);
  assert.equal(toPlace(feature, 'en').name, props.name, 'English falls back to the provider name, never to the local script');
  assert.equal(toPlace(feature, null).name, props.name, 'the local name by default');
  assert.equal(place.addressDetails.state, props.state);
  assert.equal(place.addressDetails.postcode, props.postcode);
  assert.equal(place.type, props.result_type);
  assert.equal(place.source, 'geoapify');
  assert.equal(toPlace({ properties: { name: 'x', lat: null, lon: null } }, null), null, 'null is not the point 0,0');
  assert.equal(toPlace({ properties: { name: 'x', lat: '35', lon: '45' } }, null), null, 'a text position is not a position');
  assert.equal(toPlace({ properties: { lat: 35, lon: 45 } }, null), null, 'nothing to show');
  assert.equal(toPlace({ properties: { name: 'Main', formatted: 'Main', lat: 35, lon: 45 } }, null).address, null, 'the address is not the name repeated');

  assert.equal(pickName({ name: 'N', other_names: { 'name:ckb': 'ک' } }, 'ku'), 'ک', 'Sorani (ckb) for Kurdish');
  assert.equal(pickName({ name: 'N', name_international: { ar: 'ع' } }, 'ar'), 'ع');
  assert.equal(pickName({ name: 'N' }, 'ar'), 'N');
  assert.equal(pickName({ name: 'N', other_names: { name: 'محلي' } }, 'ar'), 'محلي', 'the name in the local script when there is none in Arabic');
  assert.equal(pickName({ name: 'N', other_names: { name: 'محلي' } }, 'en'), 'N');
  assert.equal(pickName({ name: ' ' }, 'ar'), null);
  assert.equal(preferredLang('en-US,ar;q=0.8'), 'en');
  assert.equal(preferredLang('ckb'), 'ku');
  assert.equal(preferredLang('fr'), null);

  const fuel = fixture('places-fuel.json').features;
  const near = toNearbyPlace(fuel[0], 'fuel', null);
  assert.equal(near.category, 'fuel');
  assert.equal(near.providerCategory, fuel[0].properties.categories.at(-1));
  assert.equal(near.distanceMeters, Math.round(fuel[0].properties.distance));
  assert.equal(near.rating, null, 'no reviews exist: no rating, not 0 stars');
  assert.deepEqual(near.details, { brand: null, operator: null, openingHours: null, phone: null, website: null }, 'keys of the earlier answer stay');
  assert.equal(toNearbyPlace({ properties: { lat: null, lon: null } }, 'fuel', null), null);
});

test('Geoapify routes (real answers) become one LineString with steps at the right points; copies are not alternatives', () => {
  const [balanced, short, fewer] = ['route-balanced.json', 'route-short.json', 'route-less_maneuvers.json'].map((f) => fixture(f).features[0]);
  const route = normalizeGeoapifyRoute(balanced);
  assert.equal(route.geometry.type, 'LineString');
  assert.deepEqual(route.geometry.coordinates[0], balanced.geometry.coordinates[0][0], '[lng, lat] stays [lng, lat]');
  assert.equal(route.geometry.coordinates.length, balanced.geometry.coordinates.flat().length - (balanced.geometry.coordinates.length - 1), 'legs are joined without repeating the shared point');
  assert.equal(route.distance, Math.round(balanced.properties.distance * 10) / 10);
  assert.equal(route.duration, Math.round(balanced.properties.time * 10) / 10);
  assert.match(route.id, /^rt_[0-9a-f]{12}$/);
  assert.equal(route.summary, '', 'Geoapify gives no street names: nothing is invented');
  const first = route.steps[0];
  assert.equal(first.maneuver.type, 'depart');
  assert.deepEqual(first.maneuver.location, route.geometry.coordinates[0]);
  assert.equal(route.steps.at(-1).maneuver.type, 'arrive');
  assert.ok(route.steps.every((s) => typeof s.instruction === 'string' && s.instruction));
  const turn = route.steps.find((s) => s.maneuver.type === 'turn');
  assert.ok(turn && ['left', 'right'].includes(turn.maneuver.modifier));
  const gap = (a, b) => Math.hypot((a[0] - b[0]) * 91000, (a[1] - b[1]) * 111000);
  const raw = balanced.properties.legs[0].steps.find((s) => s.instruction.type === 'Right' || s.instruction.type === 'Left');
  assert.ok(gap(route.steps.find((s) => s.maneuver.type === 'turn').maneuver.location, balanced.geometry.coordinates[0][raw.from_index]) < 1, 'the step is located at from_index of the line');

  assert.deepEqual(geoapifyManeuver('StartAtLeft'), { type: 'depart', modifier: 'left' });
  assert.deepEqual(geoapifyManeuver('DestinationReachedRight'), { type: 'arrive', modifier: 'right' });
  assert.deepEqual(geoapifyManeuver('SlightLeft'), { type: 'turn', modifier: 'slight left' });
  assert.deepEqual(geoapifyManeuver('SharpRight'), { type: 'turn', modifier: 'sharp right' });
  assert.deepEqual(geoapifyManeuver('RoundaboutEnter'), { type: 'roundabout', modifier: null });
  assert.deepEqual(geoapifyManeuver('Uturn'), { type: 'turn', modifier: 'uturn' });
  assert.deepEqual(geoapifyManeuver('Continue'), { type: 'continue', modifier: 'straight' });
  assert.deepEqual(geoapifyManeuver('SomethingNew'), { type: null, modifier: null }, 'an unknown type is not guessed');

  const a = normalizeGeoapifyRoute(balanced);
  assert.equal(isSameRoad(a, normalizeGeoapifyRoute(balanced)), true, 'a route is the same road as itself');
  assert.equal(isSameRoad(a, normalizeGeoapifyRoute(short)), false, 'the short route is a different route');
  assert.equal(isSameRoad(a, normalizeGeoapifyRoute(fewer)), false, 'and so is the one with fewer turns');
  assert.equal(normalizeGeoapifyRoute({ properties: { distance: 1, time: 1 }, geometry: { type: 'LineString', coordinates: [[1, 2], [3, 4]] } }), null, 'only MultiLineString is understood');
  assert.equal(normalizeGeoapifyRoute({ properties: { distance: 'far', time: 1 }, geometry: { type: 'MultiLineString', coordinates: [[[1, 2], [3, 4]]] } }), null);
});

test('provider client: key only in a header, errors mapped without leaking, credits counted against the daily budget', async () => {
  const seen = [];
  const fetchImpl = (url, init) => { seen.push({ url, key: init.headers['x-api-key'] }); return Promise.resolve(Response.json({ ok: 1 })); };
  const make = (cfg, extra = {}) => createGeoapifyClient({
    config: { baseUrl: 'https://api.example.test', apiKey: 'secret-key-1', minIntervalMs: 0, timeoutMs: 500, dailyLimit: 0, ...cfg }, userAgent: 'UA/1', fetchImpl, ...extra,
  });

  const client = make({});
  assert.deepEqual(await client.get('/v1/x', { text: 'y z' }), { ok: 1 });
  assert.equal(seen[0].url, 'https://api.example.test/v1/x?text=y+z', 'the key is not in the URL');
  assert.equal(seen[0].key, 'secret-key-1');
  assert.equal(JSON.stringify(client.status()).includes('secret-key-1'), false, 'status never shows a key');

  const none = make({ apiKey: '' });
  assert.equal(none.enabled, false);
  await assert.rejects(none.get('/v1/x'), (e) => e.code === 'FEATURE_DISABLED' && e.status === 503);

  // daily budget in credits: a call that would go over is not sent; a new UTC day starts again
  let clock = Date.UTC(2026, 0, 1, 23, 0, 0);
  const budgeted = make({ dailyLimit: 4 }, { now: () => clock });
  await budgeted.get('/v1/x');
  await budgeted.get('/v1/x', {}, { cost: 2 });
  const callsBefore = seen.length;
  await assert.rejects(budgeted.get('/v1/x', {}, { cost: 2 }), (e) => e.code === 'PROVIDER_QUOTA_EXCEEDED' && e.status === 503 && e.retryAfterSeconds === 3600);
  assert.equal(seen.length, callsBefore, 'nothing was sent over budget');
  await budgeted.get('/v1/x');
  assert.deepEqual(budgeted.status().dailyBudget, { limit: 4, usedToday: 4 });
  clock += 3_600_000;
  await budgeted.get('/v1/x');
  assert.equal(budgeted.status().dailyBudget.usedToday, 1, 'a new UTC day starts a new budget');

  const headers = { get: (n) => (n === 'retry-after' ? '120' : null) };
  const body = (message) => ({ statusCode: 400, error: 'Bad Request', message: `${message} secret-key-1 https://x` });
  assert.equal(geoapifyError(400, body('No suitable edges near location. Please check waypoint coordinate order (lat/lon).'), headers).code, 'POINT_NOT_ROUTABLE');
  assert.equal(geoapifyError(400, body('Route not found'), headers).code, 'NO_ROUTE');
  assert.equal(geoapifyError(400, body('"waypoints[0]" does not match any of the allowed types'), headers).code, 'INVALID_REQUEST');
});

test('provider errors: auth is generic, rate limiting keeps Retry-After, an own OSRM speaks its own codes', () => {
  const headers = { get: (n) => (n === 'retry-after' ? '120' : null) };
  const limited = geoapifyError(429, null, headers);
  assert.deepEqual([limited.code, limited.status, limited.retryAfterSeconds], ['PROVIDER_BUSY', 429, 120]);
  for (const status of [401, 403]) {
    const e = geoapifyError(status, { statusCode: status, message: 'Invalid apiKey secret-key-1' }, headers);
    assert.equal(e.code, 'PROVIDER_AUTH_FAILED');
    assert.equal(e.name, 'ApiError', 'our key being refused is not a provider fault: it must not trip the breaker');
    assert.doesNotMatch(e.message, /secret-key|apiKey/, 'provider text and keys are not passed on');
  }
  assert.equal(geoapifyError(500, null, headers).code, 'PROVIDER_ERROR');
  assert.equal(osrmError(400, { code: 'NoRoute' }, headers).code, 'NO_ROUTE');
  assert.equal(osrmError(400, { code: 'NoSegment' }, headers).code, 'POINT_NOT_ROUTABLE');
  assert.equal(osrmError(400, { code: 'InvalidValue' }, headers).status, 400);
  assert.equal(osrmError(502, null, headers).code, 'PROVIDER_ERROR');
  const own = createOsrmClient({ config: { osrmUrl: '', timeoutMs: 500 } });
  assert.equal(own.enabled, false, 'there is no default OSRM server: none exists that we may use');
});

test('CORS: listed origins only, localhost in development, nothing in production, * only when asked', async () => {
  const check = (settings, origin) => new Promise((resolve) => { corsOrigin(settings)(origin, (e, ok) => resolve(ok)); });
  const dev = { any: false, origins: [], allowLocalhost: true };
  assert.equal(await check(dev, 'http://localhost:5173'), true);
  assert.equal(await check(dev, 'https://evil.example'), false);
  assert.equal(await check(dev, undefined), true, 'no Origin header: not a cross-site browser request');
  const prod = { any: false, origins: ['https://app.example.com'], allowLocalhost: false };
  assert.equal(await check(prod, 'https://app.example.com'), true);
  assert.equal(await check(prod, 'http://localhost:3000'), false);
  assert.equal(await check(prod, 'https://app.example.com.evil.test'), false);
  assert.equal(corsOrigin({ any: true, origins: [], allowLocalhost: false }), '*');
});

// ---------------------------------------------------------------- live traffic

const CFG = {
  staleAfterSeconds: 15, routeMatchMeters: 60, secondsPerVehicle: 2, longQueueVehicles: 10,
  moderateDelaySeconds: 30, heavyDelaySeconds: 90,
};
const approach = (vehicles, queueLength, waitingTime) => ({
  vehicles, queueLength, waiting: waitingTime, waitingTime, available: true, classes: null, confidence: null,
});
const unavailable = {
  vehicles: null, queueLength: null, waiting: null, waitingTime: null, available: false, classes: null, confidence: null,
};
const snapshot = (over = {}) => ({
  dataMode: 'live',
  intersectionId: 'main',
  name: 'Main Street',
  lat: IX.lat,
  lng: IX.lng,
  positionSource: 'surveyed',
  aiStatus: 'CONNECTED',
  lastUpdate: new Date(Date.now() - 2000).toISOString(),
  traffic: {
    north: approach(20, 15, 40), south: approach(2, 1, 5), east: approach(5, 3, 10), west: unavailable,
  },
  emergency: { active: false },
  ...over,
});

test('intersection view: live, stale and no-data; unavailable approaches have null counts', () => {
  const live = intersectionView(snapshot(), CFG, Date.now());
  assert.equal(live.status, 'live');
  assert.deepEqual(live.approaches.north, {
    available: true, vehicles: 20, queueLength: 15, waitingTime: 40, estimatedDelaySeconds: 80, level: 'moderate',
  });
  assert.equal(live.approaches.south.level, 'light');
  assert.equal(live.approaches.west.available, false);
  assert.equal(live.approaches.west.vehicles, null, 'never zero for a missing camera');
  assert.equal(live.level, 'moderate');
  assert.deepEqual(live.longestQueue, { direction: 'north', vehicles: 15 });

  const stale = intersectionView(snapshot({ lastUpdate: new Date(Date.now() - 60_000).toISOString() }), CFG, Date.now());
  assert.equal(stale.status, 'stale');
  assert.equal(stale.level, null, 'no congestion colour from old data');
  assert.equal(stale.approaches.north.vehicles, 20, 'the measurement is still reported, labelled stale');

  const waiting = intersectionView(snapshot({ aiStatus: 'WAITING', lastUpdate: null }), CFG, Date.now());
  assert.equal(waiting.status, 'no-data');
  assert.equal(waiting.approaches, null);

  const emergency = intersectionView(snapshot({ emergency: { active: true, type: 'ambulance', direction: 'east', since: null } }), CFG, Date.now());
  assert.deepEqual(emergency.emergency, { type: 'ambulance', direction: 'east', since: null });
});

test('route estimate: delay of the approach the route enters by, alerts, unpositioned intersections excluded', () => {
  const view = intersectionView(snapshot(), CFG, Date.now());
  const southbound = { geometry: { coordinates: line([0, 800], [0, 0], [0, -800]) }, duration: 600 };
  assert.equal(approachDirection(southbound.geometry.coordinates, IX), 'north');
  const e = estimateRoute(southbound, [view], CFG);
  assert.equal(e.live, true);
  assert.equal(e.delay, 80);
  assert.equal(e.intersections[0].approach, 'north');
  // The test grid is ellipsoidal (110 540 m per degree of latitude), geo.js spherical: ~0.6 % apart.
  assert.ok(Math.abs(e.intersections[0].alongMeters - 800) < 10, `along ${e.intersections[0].alongMeters}`);
  assert.deepEqual(e.alerts.map((a) => a.type), ['long_queue']);

  const westbound = { geometry: { coordinates: line([800, 0], [0, 0], [-800, 0]) }, duration: 600 };
  const w = estimateRoute(westbound, [view], CFG);
  assert.equal(w.intersections[0].approach, 'east');
  assert.equal(w.delay, 20);

  const eastbound = { geometry: { coordinates: line([-800, 0], [0, 0], [800, 0]) }, duration: 600 };
  const blind = estimateRoute(eastbound, [view], CFG);
  assert.equal(blind.live, false);
  assert.equal(blind.intersections[0].reason, 'video-unavailable', 'west camera missing: nothing guessed');

  const bypass = { geometry: { coordinates: line([-800, 600], [800, 600]) }, duration: 640 };
  assert.equal(estimateRoute(bypass, [view], CFG).intersections.length, 0);

  const unpositioned = { ...view, lat: null, lng: null, positionSource: 'unknown' };
  assert.equal(estimateRoute(southbound, [unpositioned], CFG).intersections.length, 0, 'an intersection without a position is not matched');

  assert.equal(trafficStatus([e, blind]), 'included');
  assert.equal(trafficStatus([blind]), 'unavailable');
  assert.equal(trafficStatus([estimateRoute(bypass, [view], CFG)]), 'not-on-route');
});

// ------------------------------------------------------------------ hardening

test('production start needs ingestion, token secrets and a database; locally nothing is enforced', () => {
  const { productionProblems } = require('../config/production');
  const good = {
    trafficIngestToken: 'i'.repeat(20), mongodbUri: 'mongodb://x', navigation: { deviceTokenSecret: 'd'.repeat(32), userTokenSecret: 'u'.repeat(32) },
  };
  assert.deepEqual(productionProblems(good), []);
  assert.equal(productionProblems({ ...good, trafficIngestToken: '' }).length, 1);
  assert.equal(productionProblems({ ...good, mongodbUri: '' }).length, 1);
  assert.equal(productionProblems({ ...good, navigation: { ...good.navigation, deviceTokenSecret: 'short' } }).length, 1);
  assert.equal(productionProblems({ ...good, navigation: { deviceTokenSecret: 'x'.repeat(32), userTokenSecret: 'x'.repeat(32) } }).length, 1, 'the two secrets must differ');
  assert.equal(productionProblems({ trafficIngestToken: '', mongodbUri: '', navigation: { deviceTokenSecret: '', userTokenSecret: '' } }).length, 4);
});

test('an operator token shorter than 16 characters disables administration', () => {
  const { execFileSync } = require('child_process');
  const read = (token) => execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./config').navigation.adminToken))"], {
    cwd: require('path').join(__dirname, '..'), env: { ...process.env, NAV_ADMIN_TOKEN: token }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  assert.equal(read('short'), '""', 'five characters: refused');
  assert.equal(read('x'.repeat(15)), '""');
  assert.equal(read('x'.repeat(16)), JSON.stringify('x'.repeat(16)));
});

test('the simulation can be watched but not driven in production', async () => {
  const express = require('express');
  const { createSimulationRoutes } = require('../routes/trafficRoutes');
  const read = new Proxy({}, { get: () => (req, res) => res.json({ ok: true }) });
  const control = new Proxy({}, { get: () => (req, res) => res.json({ ok: true, ran: true }) });
  for (const [locked, writeStatus] of [[true, 403], [false, 200]]) {
    const app = express();
    app.use('/api/simulation', createSimulationRoutes(read, control, { locked }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/simulation`;
      assert.equal((await fetch(`${base}/status`)).status, 200, 'reading is always allowed');
      for (const [method, path] of [['POST', '/start'], ['POST', '/benchmark'], ['DELETE', '/ambulance/1']]) {
        const res = await fetch(base + path, { method });
        assert.equal(res.status, writeStatus, `${method} ${path} locked=${locked}`);
        if (locked) assert.equal((await res.json()).code, 'SIMULATION_LOCKED');
      }
    } finally { server.closeAllConnections(); await new Promise((r) => { server.close(r); }); }
  }
});
