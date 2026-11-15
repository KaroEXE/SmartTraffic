// Navigation: four routes ranked best to worst from provider times plus live AI
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
  assert.deepEqual(quiet, ['a', 'b', 'c'], 'no traffic: provider times decide');
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

