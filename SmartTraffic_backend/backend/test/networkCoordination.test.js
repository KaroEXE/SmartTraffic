// Network-wide coordination: topology, network-aware decisions, downstream
// congestion, stale data, and the three-intersection emergency corridor.
// Engines run on a manual clock; no timers, no network.
const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const liveIntersections = require('../config/intersections');
const simulationIntersections = require('../config/simulationIntersections');
const { buildTopology } = require('../services/networkTopology');
const { createTrafficDecisionService } = require('../services/trafficDecisionService');
const { createNetworkCoordinator } = require('../services/networkCoordinator');
const { createEmergencyCorridorPlanner } = require('../services/emergencyCorridor');
const { createSimulationService } = require('../services/simulationService');

const DIRS = ['north', 'south', 'east', 'west'];

//   A(0,0) - B(1,0) - C(2,0)
//              |
//            D(1,1)
//              |
//            E(1,2)
const GRID = [
  { id: 'A', name: 'A', lat: 0, lng: 0, grid: { col: 0, row: 0 } },
  { id: 'B', name: 'B', lat: 0, lng: 0, grid: { col: 1, row: 0 } },
  { id: 'C', name: 'C', lat: 0, lng: 0, grid: { col: 2, row: 0 } },
  { id: 'D', name: 'D', lat: 0, lng: 0, grid: { col: 1, row: 1 } },
  { id: 'E', name: 'E', lat: 0, lng: 0, grid: { col: 1, row: 2 } },
];

function setup(defs = GRID, { coordinator = true } = {}) {
  let t = Date.UTC(2026, 0, 1);
  const now = () => t;
  const engine = createTrafficDecisionService({ intersections: defs, config, now, dataMode: 'simulation' });
  const topology = buildTopology(defs, config.network);
  const coord = coordinator
    ? createNetworkCoordinator({ engine, topology, config, now, dataMode: 'simulation', cameraCorridors: false })
    : null;
  const feed = (id, queues, extra = {}) => engine.ingest({
    intersectionId: id,
    traffic: Object.fromEntries(DIRS.map((d) => {
      const q = queues[d] === undefined ? 0 : queues[d];
      return [d, q === null ? null : { vehicles: q, queueLength: q, waiting: q ? 6 : 0 }];
    })),
    pedestrians: { north: false, south: false, east: false, west: false },
    detectors: { pedestrians: false, emergency: false },
    emergency: { detected: false, type: null, direction: null, confidence: 0 },
    ...extra,
  });
  const signals = [];
  const advance = (seconds) => {
    for (let i = 0; i < seconds * 4; i += 1) {
      t += 250;
      engine.tick();
      for (const id of engine.ids()) {
        const moving = Object.entries(engine.getSnapshot(id).signals).filter(([, s]) => s !== 'RED');
        signals.push({ id, moving });
      }
    }
  };
  return {
    engine, topology, coord, feed, advance, signals, now, setTime: (v) => { t = v; },
  };
}

// --------------------------------------------------------------- topology

test('topology: roads join neighbouring grid cells; directions follow the engine convention', () => {
  const topo = buildTopology(GRID, config.network);
  assert.deepEqual(topo.neighbors.B, { north: null, south: 'D', east: 'C', west: 'A' });
  assert.equal(topo.links.length, 8, 'four two-way roads');
  // Served on B's west approach (arriving from the west) -> travels east -> C, queues on C's west approach.
  assert.deepEqual({ to: topo.downstreamOf('B', 'west').to, approach: topo.downstreamOf('B', 'west').approach }, { to: 'C', approach: 'west' });
  assert.equal(topo.upstreamOf('B', 'west').from, 'A');
  assert.equal(topo.downstreamOf('C', 'west'), null, 'leaves the network');
  assert.equal(topo.headingBetween('D', 'B'), 'north');
  assert.equal(topo.headingBetween('A', 'C'), null, 'not adjacent');
  assert.throws(() => buildTopology([GRID[0], { ...GRID[1], grid: GRID[0].grid }]), /share grid cell/);
});

test('intersection ids are the same in the config, the topology and the engine (live and simulation)', () => {
  for (const list of [liveIntersections, simulationIntersections]) {
    const topo = buildTopology(list, config.network);
    const engine = createTrafficDecisionService({ intersections: list, config });
    assert.deepEqual(topo.nodes.map((n) => n.id), list.map((i) => i.id));
    assert.deepEqual(engine.ids(), list.map((i) => i.id));
    for (const l of topo.links) assert.ok(engine.has(l.from) && engine.has(l.to), l.id);
    for (const ix of engine.listIntersections()) assert.ok(ix.grid, `${ix.id} has a grid cell`);
    assert.ok(topo.links.length >= 8, 'the intersections are connected');
  }
});

// ------------------------------------------------------- network decisions

test('the coordinator evaluates every intersection with data together, using its neighbours', () => {
  const env = setup();
  for (const id of ['A', 'B', 'C', 'D', 'E']) env.feed(id, { north: 2, south: 2, east: 2, west: 2 });
  const d = env.coord.cycle();
  assert.deepEqual(d.evaluated.sort(), ['A', 'B', 'C', 'D', 'E']);
  const b = d.intersections.find((r) => r.intersectionId === 'B');
  assert.deepEqual(b.considered.sort(), ['A', 'B', 'C', 'D'], 'B used its three neighbours');
  assert.equal(b.candidates.length, 4);
  assert.equal(d.links.length, env.topology.links.length);
  assert.ok(env.engine.getSnapshot('B').network, 'the engine received network scores');
});

test('downstream congestion overrides the largest local queue (and the decision says why)', () => {
  const env = setup();
  const congest = () => {
    // B: west (towards C) has the largest queue; north (towards D) a smaller one.
    env.feed('B', { west: 30, north: 12 });
    env.feed('C', { west: 38 }); // the road B -> C is nearly full (capacity 40)
    env.feed('D', { north: 0 });
    for (const id of ['A', 'E']) env.feed(id, {});
  };
  congest();
  env.advance(1);
  congest();
  env.coord.cycle();
  congest();
  const d = env.coord.cycle(); // blocked must persist BLOCKED_CYCLES cycles
  const b = d.intersections.find((r) => r.intersectionId === 'B');
  const west = b.candidates.find((c) => c.approach === 'west');
  const north = b.candidates.find((c) => c.approach === 'north');
  assert.ok(west.local > north.local, 'locally, WEST is the busiest approach');
  assert.equal(west.blocked, true);
  assert.equal(west.network, 0);
  assert.equal(west.downstream.to, 'C');
  assert.equal(b.localBest, 'west');
  assert.equal(b.recommended, 'north', 'network-aware choice is NORTH, not the largest queue');
  assert.equal(b.networkChangedChoice, true);
  assert.match(b.reason, /WEST has the largest local demand.*blocked/);

  // Without the coordinator the same data picks WEST.
  const alone = setup(GRID, { coordinator: false });
  alone.feed('B', { west: 30, north: 12 });
  alone.advance(25);
  alone.feed('B', { west: 30, north: 12 });
  alone.advance(25);
  const greens = new Set(alone.signals.filter((s) => s.id === 'B' && s.moving.length).map((s) => s.moving[0][0]));
  assert.ok(greens.has('west'), 'local control releases WEST into the jam');

  // With it, B never serves WEST while C is full.
  for (let s = 0; s < 60; s += 2) {
    congest();
    env.coord.cycle();
    env.advance(2);
  }
  const bGreens = env.signals.filter((s) => s.id === 'B' && s.moving.length && s.moving[0][1] === 'GREEN').map((s) => s.moving[0][0]);
  assert.ok(bGreens.includes('north'));
  assert.ok(!bGreens.slice(-200).includes('west'), 'no green into the blocked road');
});

test('a platoon released upstream raises the downstream approach (green wave)', () => {
  const env = setup();
  // Only A's WEST approach has demand, so A soon serves it - releasing vehicles toward B.
  let a = null;
  for (let s = 0; s < 90; s += 1) {
    env.feed('A', { west: 9 });
    env.advance(1);
    a = env.engine.getSnapshot('A');
    if (a.phase === 'GREEN' && a.greenDirection === 'west') break;
  }
  assert.equal(a.greenDirection, 'west');
  env.feed('A', { west: 9 });
  env.feed('B', { west: 1, north: 1 });
  const d = env.coord.cycle();
  const b = d.intersections.find((r) => r.intersectionId === 'B');
  const west = b.candidates.find((c) => c.approach === 'west');
  const north = b.candidates.find((c) => c.approach === 'north');
  assert.equal(west.platoon, 9);
  assert.equal(west.local, north.local, 'same local demand');
  assert.ok(west.network > north.network, 'the approach receiving the platoon ranks higher');
  assert.match(west.note, /9 vehicles arriving from A/);
  assert.match(west.note, /exit to C has no data/, 'both facts are reported');
  assert.equal(d.links.find((l) => l.id === 'A>B').releasing, true);
});

test('missing and stale data are never treated as zero traffic', () => {
  const env = setup();
  env.feed('B', { north: 10 });
  env.feed('A', {});
  // D has never reported: B's north road leads into unknown.
  let d = env.coord.cycle();
  let b = d.intersections.find((r) => r.intersectionId === 'B');
  const north = b.candidates.find((c) => c.approach === 'north');
  assert.equal(north.downstream.queue, null);
  assert.equal(north.downstream.state, 'unknown');
  assert.equal(north.factor, 1, 'unknown is neither penalised nor preferred');
  assert.match(north.note, /no data/);
  const dRec = d.intersections.find((r) => r.intersectionId === 'D');
  assert.equal(dRec.evaluated, false);
  assert.equal(dRec.status, 'nodata');
  assert.equal(env.engine.getSnapshot('D').network, null, 'no advice without data');
  assert.equal(d.links.find((l) => l.id === 'B>D').state, 'unknown');

  // A goes stale: its advice is withdrawn and neighbours stop using its numbers.
  env.advance(config.timing.DATA_TIMEOUT + 2);
  env.feed('B', { north: 10 });
  d = env.coord.cycle();
  assert.equal(env.engine.getSnapshot('A').aiStatus, 'STALE');
  assert.equal(d.intersections.find((r) => r.intersectionId === 'A').status, 'stale');
  assert.equal(env.engine.getSnapshot('A').network, null);
  b = d.intersections.find((r) => r.intersectionId === 'B');
  assert.equal(b.candidates.find((c) => c.approach === 'east').downstream.queue, null, "A's stale queue is not used");
});

test('turning network optimisation off returns every intersection to local decisions', () => {
  const env = setup();
  env.feed('B', { west: 5 });
  env.coord.cycle();
  assert.ok(env.engine.getSnapshot('B').network);
  env.coord.setEnabled(false);
  assert.equal(env.engine.getSnapshot('B').network, null);
  const d = env.coord.cycle();
  assert.equal(d.enabled, false);
  assert.match(d.intersections.find((r) => r.intersectionId === 'B').action, /network optimisation off/);
});

// ------------------------------------------------------- emergency corridor

const planner = (defs = GRID, settings = config.network) => {
  let t = 0;
  return {
    p: createEmergencyCorridorPlanner({ topology: buildTopology(defs, settings), settings, now: () => t }),
    tick: (ms) => { t += ms; },
  };
};

test('corridor: the next three intersections along the actual route, not the nearest ones', () => {
  const { p } = planner();
  // Northbound from E, turning west at B: E -> D -> B -> A. C is as close to B as A is.
  const r = p.updateTrack({
    id: 'amb-1', type: 'ambulance', source: 'simulation', towards: 'D', distanceM: 100, speedMps: 10, route: ['E', 'D', 'B', 'A'],
  });
  assert.equal(r.ok, true, r.error);
  const plan = p.plan({ intersections: {}, links: {} });
  const c = plan.corridors[0];
  assert.deepEqual(c.entries.map((e) => [e.intersectionId, e.approach]), [['D', 'south'], ['B', 'south'], ['A', 'east']]);
  assert.ok(!c.entries.some((e) => e.intersectionId === 'C'));
  assert.deepEqual(c.passed, ['E']);

  // Without a route the vehicle is assumed to go straight on.
  const straight = planner();
  straight.p.updateTrack({ id: 'x', source: 'camera', towards: 'D', approach: 'south', distanceM: 0 });
  const s = straight.p.plan({ intersections: {}, links: {} }).corridors[0];
  assert.deepEqual(s.entries.map((e) => e.intersectionId), ['D', 'B']);
  assert.equal(s.routeAssumed, true);

  assert.match(p.updateTrack({ id: 'y', towards: 'D', route: ['E', 'D', 'C'] }).error, /not a road/);
  assert.match(p.updateTrack({ id: 'y', towards: 'D', route: ['E', 'B'] }).error, /does not contain/);
  assert.match(p.updateTrack({ id: 'y', towards: 'Z', approach: 'north' }).error, /unknown intersection/);
});

test('corridor: staged by arrival time - planned, preparing, holding', () => {
  const { p } = planner();
  p.updateTrack({ id: 'amb', towards: 'D', distanceM: 100, speedMps: 10, route: ['E', 'D', 'B', 'A'] });
  let plan = p.plan({ intersections: {}, links: {} });
  let e = plan.corridors[0].entries;
  assert.deepEqual(e.map((x) => [x.intersectionId, x.etaSeconds, x.stage]), [['D', 10, 'preparing'], ['B', 30, 'preparing'], ['A', 50, 'planned']]);
  assert.deepEqual([...plan.directives.keys()].sort(), ['B', 'D'], 'A is not touched yet');
  assert.equal(plan.directives.get('D').direction, 'south');

  p.updateTrack({ id: 'amb', towards: 'D', distanceM: 30, speedMps: 10, route: ['E', 'D', 'B', 'A'] });
  plan = p.plan({ intersections: {}, links: {} });
  e = plan.corridors[0].entries;
  assert.equal(e[0].stage, 'holding');
  assert.equal(e[1].stage, 'preparing');
  assert.equal(e[2].stage, 'planned', 'staged: the farthest intersection still waits');
});

test('corridor: a route change moves the corridor; passed intersections are released', () => {
  const { p } = planner();
  p.updateTrack({ id: 'amb', towards: 'D', distanceM: 50, speedMps: 10, route: ['E', 'D', 'B', 'A'] });
  assert.deepEqual(p.plan({ intersections: {}, links: {} }).corridors[0].entries.map((e) => e.intersectionId), ['D', 'B', 'A']);
  const rerouted = p.updateTrack({ id: 'amb', towards: 'D', distanceM: 40, speedMps: 10, route: ['E', 'D', 'B', 'C'] });
  assert.equal(rerouted.ok, true);
  let plan = p.plan({ intersections: {}, links: {} });
  assert.deepEqual(plan.corridors[0].entries.map((e) => [e.intersectionId, e.approach]), [['D', 'south'], ['B', 'south'], ['C', 'west']]);
  assert.equal(plan.corridors[0].rerouted, true);
  assert.ok(!plan.directives.has('A'));

  // Past D: D drops out, C is next.
  p.updateTrack({ id: 'amb', towards: 'B', distanceM: 150, speedMps: 10, route: ['E', 'D', 'B', 'C'] });
  plan = p.plan({ intersections: {}, links: {} });
  assert.deepEqual(plan.corridors[0].entries.map((e) => e.intersectionId), ['B', 'C']);
  assert.ok(plan.corridors[0].passed.includes('D'));
  assert.ok(!plan.directives.has('D'));
});

test('corridor: conflicting corridors - the earlier arrival wins, the other is told why', () => {
  const { p } = planner();
  p.updateTrack({ id: 'north-bound', towards: 'B', approach: 'south', distanceM: 50, speedMps: 10 });
  p.updateTrack({ id: 'east-bound', towards: 'B', approach: 'west', distanceM: 150, speedMps: 10 });
  const plan = p.plan({ intersections: {}, links: {} });
  assert.equal(plan.directives.get('B').vehicleId, 'north-bound');
  const loser = plan.corridors.find((c) => c.vehicleId === 'east-bound').entries.find((e) => e.intersectionId === 'B');
  assert.equal(loser.status, 'conflict');
  assert.match(loser.reason, /yields to .*north-bound/);
});

test('corridor: a blocked road ahead is reported and the next intersection is asked to clear it', () => {
  const { p } = planner(GRID, { ...config.network, CORRIDOR_LENGTH: 1 });
  p.updateTrack({ id: 'amb', towards: 'A', approach: 'west', distanceM: 60, speedMps: 10 });
  const view = {
    intersections: {},
    links: { 'A>B': { state: 'blocked', queue: 39, capacity: 40, approach: 'west' } },
  };
  const plan = p.plan(view);
  const entry = plan.corridors[0].entries[0];
  assert.equal(entry.status, 'exit-blocked');
  assert.match(entry.reason, /road to B is blocked/);
  assert.equal(plan.directives.get('B').purpose, 'flush');
  assert.equal(plan.directives.get('B').direction, 'west');
});

test('engine: a corridor never skips yellow or all-red, and waits for minimum green while there is time', () => {
  const env = setup();
  env.feed('B', { east: 8, south: 2 });
  env.advance(2); // B green on some approach, within minimum green
  const serving = env.engine.getSnapshot('B').greenDirection;
  const target = DIRS.find((d) => d !== serving);
  env.engine.setCorridorDirective('B', {
    vehicleId: 'amb', type: 'ambulance', direction: target, stage: 'preparing', etaSeconds: 25,
  });
  env.advance(1);
  const s = env.engine.getSnapshot('B');
  assert.equal(s.mode, 'EMERGENCY');
  assert.equal(s.greenDirection, serving, 'far away: minimum green respected');
  assert.match(s.reason, /after minimum green/);

  env.engine.setCorridorDirective('B', {
    vehicleId: 'amb', type: 'ambulance', direction: target, stage: 'holding', etaSeconds: 4,
  });
  env.signals.length = 0;
  env.advance(8);
  const seq = env.signals.filter((x) => x.id === 'B').map((x) => (x.moving[0] ? `${x.moving[0][0]}:${x.moving[0][1]}` : 'ALL_RED'));
  const firstYellow = seq.indexOf(`${serving}:YELLOW`);
  const firstTarget = seq.indexOf(`${target}:GREEN`);
  assert.ok(firstYellow >= 0 && firstTarget > firstYellow, 'yellow before the new green');
  assert.ok(seq.slice(firstYellow, firstTarget).includes('ALL_RED'), 'all-red clearance before the new green');
  assert.equal(env.engine.getSnapshot('B').holding, 'EMERGENCY');

  // Released: back to normal through the normal transitions.
  env.engine.setCorridorDirective('B', null);
  assert.equal(env.engine.getSnapshot('B').corridor, null);
  assert.notEqual(env.engine.getSnapshot('B').holding, 'EMERGENCY');
  const events = env.engine.getSnapshot('B', { includeEvents: true }).events.map((e) => e.message);
  assert.ok(events.some((m) => /Emergency corridor released/.test(m)));
});

test('never two approaches green (or yellow) at once - network decisions and corridors included', () => {
  const env = setup();
  for (let s = 0; s < 400; s += 1) {
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      const k = id.charCodeAt(0);
      env.feed(id, Object.fromEntries(DIRS.map((d, i) => [d, ((s + k) * (i + 3)) % 41])));
    }
    if (s === 100) {
      env.coord.planner.updateTrack({ id: 'amb', towards: 'D', distanceM: 300, speedMps: 12, route: ['E', 'D', 'B', 'A'] });
    }
    if (s > 100 && s < 160) {
      env.coord.planner.updateTrack({ id: 'amb', towards: s < 125 ? 'D' : 'B', distanceM: Math.max(0, s < 125 ? 300 - (s - 100) * 12 : 200 - (s - 125) * 12), speedMps: 12, route: ['E', 'D', 'B', 'A'] });
    }
    if (s % 2 === 0) env.coord.cycle();
    env.advance(1);
  }
  const conflicts = env.signals.filter((x) => x.moving.length > 1);
  assert.equal(conflicts.length, 0, `conflicting movements: ${JSON.stringify(conflicts.slice(0, 3))}`);
});

// --------------------------------------------------------------- simulation

test('simulation: a dispatched ambulance gets a staged corridor along its route and every intersection returns to normal', () => {
  let t = Date.parse('2026-10-20T10:00:00Z');
  let seed = 9;
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const sim = createSimulationService({
    intersections: simulationIntersections, config, real: () => t, random, generatorTickMs: 1e9, engineTickMs: 1e9,
  });
  const decisions = [];
  sim.coordinator.on('decision', (d) => decisions.push(d));
  const advance = (s) => {
    for (let i = 0; i < s * 4; i += 1) {
      t += 250;
      sim.engine.tick();
      if (i % 4 === 3) sim.tick();
    }
  };
  try {
    sim.start();
    advance(60);
    assert.equal(sim.dispatchAmbulance({ from: 'nowhere', heading: 'east' }).status, 404);
    assert.equal(sim.dispatchAmbulance({ from: 'main', heading: 'up' }).status, 400);
    assert.equal(sim.dispatchAmbulance({ from: 'main', route: ['main', 'university-road'] }).status, 400, 'not adjacent');
    const res = sim.dispatchAmbulance({ from: 'main', heading: 'east' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.status.ambulances[0].route, ['main', 'market-square', 'stadium-road']);
    assert.equal(sim.rerouteAmbulance(res.vehicleId, ['stadium-road']).status, 400, 'must start at the next intersection');

    const seen = new Set();
    for (let s = 0; s < 70 && !sim.getStatus().lastAmbulance; s += 1) {
      advance(1);
      const d = decisions[decisions.length - 1];
      for (const c of d.corridors) {
        assert.ok(c.entries.length <= config.network.CORRIDOR_LENGTH);
        for (const e of c.entries) seen.add(e.intersectionId);
      }
    }
    const done = sim.getStatus().lastAmbulance;
    assert.ok(done, 'the ambulance reached the end of its route');
    assert.deepEqual([...seen].sort(), ['main', 'market-square', 'stadium-road'], 'only intersections on its route');
    advance(10);
    for (const snap of sim.engine.getAllSnapshots()) assert.equal(snap.corridor, null, `${snap.intersectionId} released`);
    assert.ok(done.stops <= 1, `few stops with the corridor (${done.stops})`);
  } finally {
    sim.reset();
  }
});

test('a camera sighting of a tracked vehicle does not create a second corridor', () => {
  const env = setup();
  env.coord.cameraCorridors = true;
  env.coord.planner.updateTrack({ id: 'amb', towards: 'D', distanceM: 40, speedMps: 12, route: ['E', 'D', 'B', 'A'] });
  // D's camera sees the same ambulance on its south approach.
  env.feed('D', {}, { emergency: { detected: true, type: 'ambulance', direction: 'south', confidence: 0.95 } });
  let d = env.coord.cycle();
  assert.deepEqual(d.corridors.map((c) => c.vehicleId), ['amb']);
  // A vehicle nobody tracks: the camera detection starts an estimated corridor.
  env.feed('C', {}, { emergency: { detected: true, type: 'police', direction: 'east', confidence: 0.95 } });
  d = env.coord.cycle();
  const camera = d.corridors.find((c) => c.source === 'camera');
  assert.ok(camera, 'untracked camera detection gets a corridor');
  assert.equal(camera.routeAssumed, true);
  assert.deepEqual(camera.entries.map((e) => e.intersectionId), ['C', 'B', 'A']);
  assert.ok(camera.entries.every((e) => e.etaEstimated));
});
