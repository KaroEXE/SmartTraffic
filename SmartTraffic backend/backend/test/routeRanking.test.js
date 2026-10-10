// Navigation: four routes ranked best to worst from OSRM times plus live AI
// traffic (frontend/navigation/routeRanking.js, routeService.findMoreRoutes).
// No browser, map or network: routes are built from coordinates here.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (file) => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'navigation', file)).href);

// Monitored intersection at the origin of a small local grid.
const IX = { lat: 35.5617, lng: 45.4329 };
const M_LAT = 1 / 110540;
const M_LNG = 1 / (111320 * Math.cos((IX.lat * Math.PI) / 180));
// Point `x` metres east and `y` metres north of the intersection, as [lat, lng].
const at = (x, y) => [IX.lat + y * M_LAT, IX.lng + x * M_LNG];
const route = (id, duration, points, distance = 2000) => ({ id, duration, distance, coordinates: points.map(([x, y]) => at(x, y)) });

// Through the intersection southbound (enters from the north approach).
const SOUTHBOUND = route('a', 600, [[0, 800], [0, 0], [0, -800]]);
// Through it eastbound (enters from the west approach).
const EASTBOUND = route('b', 610, [[-800, 0], [0, 0], [800, 0]]);
// Nowhere near it.
const BYPASS = route('c', 640, [[-800, 600], [800, 600]]);

const view = (approaches, status = 'live') => ({
  id: 'main', name: 'Main Street', located: true, lat: IX.lat, lng: IX.lng, status,
  approaches: {
    north: { vehicles: 0, queueLength: 0, waitingTime: 0 },
    south: { vehicles: 0, queueLength: 0, waitingTime: 0 },
    east: { vehicles: 0, queueLength: 0, waitingTime: 0 },
    west: { vehicles: 0, queueLength: 0, waitingTime: 0 },
    ...approaches,
  },
});

test('the approach a route enters by follows its travel direction', async () => {
  const { approachDirection } = await load('routeRanking.js');
  assert.equal(approachDirection(SOUTHBOUND.coordinates, IX), 'north');
  assert.equal(approachDirection(EASTBOUND.coordinates, IX), 'west');
  assert.equal(approachDirection(route('x', 1, [[0, -800], [0, 0], [0, 800]]).coordinates, IX), 'south');
  assert.equal(approachDirection(route('x', 1, [[800, 0], [0, 0], [-800, 0]]).coordinates, IX), 'east');
  assert.equal(approachDirection(route('x', 1, [[0, 0], [0, 800]]).coordinates, IX), null, 'starts at the intersection');
});

test('live delay uses the entered approach: mean wait + 2 s per vehicle', async () => {
  const { estimateRoute } = await load('routeRanking.js');
  const views = [view({ north: { vehicles: 6, queueLength: 4, waitingTime: 12 }, west: { vehicles: 1, queueLength: 0, waitingTime: 0 } })];
  const south = estimateRoute(SOUTHBOUND, views);
  assert.equal(south.delay, 12 + 6 * 2);
  assert.equal(south.duration, 600 + 24);
  assert.equal(south.live, true);
  assert.equal(south.intersections[0].approach, 'north');
  assert.equal(estimateRoute(EASTBOUND, views).delay, 2);
  const away = estimateRoute(BYPASS, views);
  assert.deepEqual([away.delay, away.live, away.intersections.length], [0, false, 0]);
});

test('no live data, or a missing camera video, adds nothing and says why', async () => {
  const { estimateRoute, liveStatus } = await load('routeRanking.js');
  const stale = estimateRoute(SOUTHBOUND, [view({ north: { vehicles: 9, queueLength: 9, waitingTime: 60 } }, 'stale')]);
  assert.deepEqual([stale.delay, stale.live, stale.intersections[0].reason], [0, false, 'no live data']);
  const noVideo = estimateRoute(SOUTHBOUND, [view({ north: { vehicles: null, queueLength: null, waitingTime: null } })]);
  assert.deepEqual([noVideo.delay, noVideo.intersections[0].reason], [0, 'video unavailable']);
  assert.equal(liveStatus(new Map([['a', stale]])), 'unavailable');
  assert.equal(liveStatus(new Map([['c', estimateRoute(BYPASS, [])]])), 'not-on-route');
});

test('heavier traffic at the intersection pushes the routes through it down the ranking', async () => {
  const { estimateRoute, orderRoutes } = await load('routeRanking.js');
  const routes = [SOUTHBOUND, EASTBOUND, BYPASS];
  const rank = (views, previous) => {
    const est = new Map(routes.map((r) => [r.id, estimateRoute(r, views)]));
    return orderRoutes(routes, est, previous, { hysteresisSeconds: 5 });
  };
  const quiet = rank([view({})]);
  assert.deepEqual(quiet, ['a', 'b', 'c'], 'no traffic: OSRM times decide');
  // The north approach fills up (the southbound route enters there).
  const busyNorth = rank([view({ north: { vehicles: 9, queueLength: 7, waitingTime: 30 } })], quiet); // 600 + 30 + 18 s
  assert.deepEqual(busyNorth, ['b', 'c', 'a']);
  // Everything through the junction is slow: the bypass becomes the best route.
  const jammed = rank([view({ north: { vehicles: 9, waitingTime: 30 }, west: { vehicles: 9, waitingTime: 30 } })], busyNorth);
  assert.deepEqual(jammed, ['c', 'a', 'b']); // 640 / 648 / 658 s
  // Traffic clears: back to the routing order.
  assert.deepEqual(rank([view({})], jammed), ['a', 'b', 'c']);
});

test('near-equal routes keep their places (hysteresis); distance breaks exact ties', async () => {
  const { orderRoutes } = await load('routeRanking.js');
  const routes = [route('a', 600, [[0, 0], [1, 1]], 3000), route('b', 600, [[0, 0], [1, 1]], 2500)];
  const est = (a, b) => new Map([['a', { duration: a }], ['b', { duration: b }]]);
  assert.deepEqual(orderRoutes(routes, est(600, 600)), ['b', 'a'], 'same time: shorter first');
  assert.deepEqual(orderRoutes(routes, est(600, 603), ['a', 'b'], { hysteresisSeconds: 5 }), ['a', 'b']);
  assert.deepEqual(orderRoutes(routes, est(597, 600), ['b', 'a'], { hysteresisSeconds: 5 }), ['b', 'a'], 'a 3 s gain does not reorder');
  assert.deepEqual(orderRoutes(routes, est(590, 600), ['b', 'a'], { hysteresisSeconds: 5 }), ['a', 'b'], 'a 10 s gain does');
});

test('labels and colours run from best (green) to slowest (red)', async () => {
  const { rankLabel, rankColor, RANK_COLORS } = await load('routeRanking.js');
  assert.deepEqual([0, 1, 2, 3].map((i) => rankLabel(i, 4)), ['Best', '2nd best', '3rd best', 'Slowest']);
  assert.deepEqual([0, 1, 2, 3].map((i) => rankColor(i, 4)), RANK_COLORS);
  assert.deepEqual([0, 1].map((i) => rankColor(i, 2)), [RANK_COLORS[0], RANK_COLORS[3]], 'worst is always red');
});

test('an extra route must use different roads and must not double back', async () => {
  const { isUsefulAlternative, hasBacktrack, overlapRatio } = await load('routeRanking.js');
  const main = route('a', 600, [[0, -1000], [0, 1000]]);
  const sameRoad = route('x', 610, [[3, -1000], [3, 1000]]);
  const parallel = route('y', 650, [[0, -1000], [400, -600], [400, 600], [0, 1000]]);
  const spur = route('z', 700, [[0, -1000], [0, 0], [600, 0], [0, 0], [0, 1000]]);
  assert.ok(overlapRatio(sameRoad.coordinates, main.coordinates) > 0.95);
  assert.equal(isUsefulAlternative(sameRoad, [main]), false, 'same road shifted a little is not a new route');
  assert.equal(isUsefulAlternative(parallel, [main]), true);
  assert.equal(hasBacktrack(spur.coordinates), true);
  assert.equal(isUsefulAlternative(spur, [main]), false, 'out-and-back to a via point is not a route');
  assert.equal(isUsefulAlternative({ ...parallel, duration: 600 * 3 }, [main]), false, 'absurd detour');
});

test('findMoreRoutes adds real OSRM via routes until there are four, spaced for the rate limit', async () => {
  const { findMoreRoutes } = await load('routeService.js');
  const { NAV_CONFIG } = await load('config.js');
  const start = { lat: IX.lat, lng: IX.lng };
  const destination = { lat: IX.lat + 2000 * M_LAT, lng: IX.lng };
  const existing = [{ ...route('osrm-0', 600, [[0, 0], [0, 2000]]), index: 0, source: 'osrm', summary: '' }];
  const requests = [];
  const original = global.fetch;
  // Each via request answers with a road-following route through that via point;
  // the second via point returns the same road as an earlier one (rejected).
  global.fetch = async (url) => {
    requests.push({ url, at: Date.now() });
    if (url.includes('/nearest/')) {
      // Two roads near the point: the nearest is tried first.
      const [lng, lat] = url.split('/driving/')[1].split('?')[0].split(',').map(Number);
      return { ok: true, status: 200, json: async () => ({ code: 'Ok', waypoints: [
        { name: '101-9', location: [lng, lat], distance: 3 },
        { name: 'Salim Street', location: [lng, lat], distance: 20 },
      ] }) };
    }
    const via = url.split('/driving/')[1].split('?')[0].split(';')[1].split(',').map(Number);
    const side = Math.sign(via[1] - IX.lng);
    const k = requests.filter((r) => !r.url.includes('/nearest/')).length;
    const x = k === 2 ? 400 * side + 2 : [0, 400, 400, 900, 900, 1400][k - 1] * side;
    const coords = [[0, 0], [x, 300], [x, 1700], [0, 2000]].map(([mx, my]) => [IX.lng + mx * M_LNG, IX.lat + my * M_LAT]);
    return { ok: true, status: 200, json: async () => ({ code: 'Ok', routes: [{ distance: 2600 + k, duration: 650 + k * 10, legs: [], geometry: { type: 'LineString', coordinates: coords } }] }) };
  };
  try {
    const cfg = { ...NAV_CONFIG.routing, minIntervalMs: 20 };
    const added = [];
    const found = await findMoreRoutes(start, destination, existing, { cfg, onRoute: (r) => added.push(r.id) });
    assert.equal(existing.length + found.length, 4, 'four routes in total');
    assert.deepEqual(found.map((r) => r.id), added);
    const routeRequests = requests.filter((r) => !r.url.includes('/nearest/'));
    assert.ok(routeRequests.every((r) => /;/.test(r.url.split('/driving/')[1]) && /alternatives=false/.test(r.url)), 'via-point requests only');
    assert.ok(requests.filter((r) => r.url.includes('/nearest/')).length >= 1, 'via points are snapped to named roads first');
    assert.ok(routeRequests.length <= cfg.maxViaRequests);
    for (let i = 1; i < requests.length; i += 1) assert.ok(requests[i].at - requests[i - 1].at >= 15, 'requests are spaced');
    assert.ok(found.every((r) => r.coordinates.length >= 2), 'road geometry from the provider, never a straight line');
  } finally {
    global.fetch = original;
  }
});
