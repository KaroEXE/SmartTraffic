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
const v = require('../utils/navValidation');
const { instructionFor, routeSteps, normalizeRoute, routeId } = require('../services/navigation/routingService');
const { toPlace } = require('../services/navigation/geocodingService');
const { parseRoadFeatures, tilesFor, parseNearby } = require('../services/navigation/overpassService');
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

test('alternatives: a route that doubles back or copies another is not useful', () => {
  const direct = { geometry: { coordinates: line([0, -800], [0, 800]) }, duration: 600 };
  const copy = { geometry: { coordinates: line([0, -800], [0, 800]) }, duration: 610 };
  const spur = { geometry: { coordinates: line([0, -800], [0, 0], [400, 0], [0, 0], [0, 800]) }, duration: 700 };
  const other = { geometry: { coordinates: line([0, -800], [600, -400], [600, 400], [0, 800]) }, duration: 800 };
  const absurd = { geometry: { coordinates: line([0, -800], [-900, 0], [0, 800]) }, duration: 1600 };
  assert.equal(geo.isUsefulAlternative(copy, [direct]), false);
  assert.equal(geo.isUsefulAlternative(spur, [direct]), false);
  assert.equal(geo.isUsefulAlternative(other, [direct]), true);
  assert.equal(geo.isUsefulAlternative(absurd, [direct]), false, 'more than 2.5x the fastest time');
  assert.equal(geo.viaCandidates(IX, { lat: IX.lat + 0.02, lng: IX.lng }).length, 12);
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

test('OSRM steps: English instructions, and no arrive/depart at an internal via point', () => {
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

test('OSRM routes are normalised with a stable geometry-derived id', () => {
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
});

test('Nominatim and Overpass answers are parsed into the API shapes', () => {
  const place = toPlace({
    osm_type: 'way', osm_id: 7, lat: '35.56', lon: '45.43', name: 'Hospital', display_name: 'Hospital, Main St, City', category: 'amenity', type: 'hospital',
    address: { road: 'Main St', city: 'City', country_code: 'iq' },
  });
  assert.equal(place.id, 'osm:way:7');
  assert.equal(place.addressDetails.city, 'City');
  assert.equal(toPlace({ lat: 'x', lon: '1' }), null);

  const features = parseRoadFeatures({
    elements: [
      { type: 'node', id: 1, lat: 35.5, lon: 45.4, tags: { highway: 'speed_camera', maxspeed: '50 mph', direction: 'NE' } },
      { type: 'way', id: 2, center: { lat: 35.51, lon: 45.41 }, tags: { traffic_calming: 'hump' } },
      { type: 'node', id: 3, lat: 35.52, lon: 45.42, tags: { highway: 'bus_stop' } },
    ],
  });
  assert.equal(features.length, 2);
  assert.equal(features[0].speedLimitKmh, 80);
  assert.equal(features[0].direction, 45);
  assert.equal(features[0].verification, 'community');
  assert.equal(features[1].name, 'Speed hump');
  assert.deepEqual(tilesFor({ south: 0.01, west: 0.01, north: 0.06, east: 0.04 }, 0.05), ['0:0', '0:1']);

  const nearby = parseNearby({ elements: [{ type: 'node', id: 9, lat: 35.5, lon: 45.4, tags: { brand: 'FuelCo', 'addr:street': 'Main', 'addr:housenumber': '4' } }] }, { lat: 35.5, lng: 45.4 }, 'fuel');
  assert.equal(nearby[0].name, 'FuelCo');
  assert.equal(nearby[0].address, 'Main 4');
});

// ---------------------------------------------------------------- live traffic

const CFG = {
  staleAfterSeconds: 15, routeMatchMeters: 60, secondsPerVehicle: 2, longQueueVehicles: 10,
  moderateDelaySeconds: 30, heavyDelaySeconds: 90, includePlaceholderPositions: false,
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

test('route estimate: delay of the approach the route enters by, alerts, placeholders excluded', () => {
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

  const placeholder = { ...view, positionSource: 'placeholder' };
  assert.equal(estimateRoute(southbound, [placeholder], CFG).intersections.length, 0, 'unsurveyed positions are not matched');
  assert.equal(estimateRoute(southbound, [placeholder], { ...CFG, includePlaceholderPositions: true }).delay, 80);

  assert.equal(trafficStatus([e, blind]), 'included');
  assert.equal(trafficStatus([blind]), 'unavailable');
  assert.equal(trafficStatus([estimateRoute(bypass, [view], CFG)]), 'not-on-route');
});
