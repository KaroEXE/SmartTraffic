const test = require('node:test');
const assert = require('node:assert/strict');

const { createTrafficDecisionService, normalizeObservation } = require('./trafficDecisionService');
const { bindTrafficEvents } = require('../socket/trafficSocket');

// Engine-level tests: payloads go straight into service.ingest() in the
// shape a traffic-state store would pass (`waitingTime`, no REST validation).

const DIRECTIONS = ['north', 'south', 'east', 'west'];
const SIGNAL_VALUES = ['RED', 'YELLOW', 'GREEN'];

const config = {
  weights: { vehicles: 2, waiting: 3, queueLength: 2 },
  timing: {
    MIN_GREEN_TIME: 10,
    MAX_GREEN_TIME: 45,
    YELLOW_TIME: 3,
    ALL_RED_TIME: 1,
    SECONDS_PER_QUEUED_VEHICLE: 2,
    MAX_RED_TIME: 90,
    MIN_PEDESTRIAN_CROSSING_TIME: 10,
    PEDESTRIAN_CLEARANCE_TIME: 3,
    PEDESTRIAN_MAX_WAIT: 15,
    PEDESTRIAN_COOLDOWN: 20,
    EMERGENCY_MAX_HOLD_TIME: 90,
    PERCEPTION_HOLD_TIME: 3,
    DATA_TIMEOUT: 10,
    FALLBACK_GREEN_TIME: 20,
  },
  EMERGENCY_CONFIDENCE_THRESHOLD: 0.8,
};

const NO_EMERGENCY = { detected: false, type: null, direction: null, confidence: 0 };

const SPEC_TRAFFIC = {
  north: { vehicles: 12, queueLength: 8, waitingTime: 15 },
  south: { vehicles: 4, queueLength: 3, waitingTime: 7 },
  east: { vehicles: 20, queueLength: 15, waitingTime: 22 },
  west: { vehicles: 5, queueLength: 4, waitingTime: 10 },
};

function input({ traffic = SPEC_TRAFFIC, pedestrians = {}, emergency = NO_EMERGENCY } = {}) {
  return {
    intersectionId: 'main',
    traffic,
    pedestrians: { north: false, south: false, east: false, west: false, ...pedestrians },
    emergency,
  };
}

function uniform(entry) {
  return Object.fromEntries(DIRECTIONS.map((d) => [d, { ...entry }]));
}

/** Fake clock; feed() is ingested once per simulated second, tick() every 250 ms. */
function setup() {
  let t = 1_000_000;
  const svc = createTrafficDecisionService({
    intersections: [{ id: 'main', name: 'Main', lat: 0, lng: 0 }],
    config,
    now: () => t,
  });
  let n = 0;
  const step = (feed) => {
    t += 250;
    if (feed && n % 4 === 0) svc.ingest(feed());
    n += 1;
    svc.tick();
  };
  const advance = (seconds, feed) => {
    for (let i = 0; i < seconds * 4; i += 1) step(feed);
  };
  return { svc, step, advance, now: () => t, snap: () => svc.getSnapshot('main') };
}

/** Per-second (phase, greenDirection, mode) trace, for comparing two runs. */
function trace(env, seconds, feed) {
  const out = [];
  for (let s = 0; s < seconds; s += 1) {
    env.advance(1, feed);
    const { phase, greenDirection, mode } = env.snap().signal;
    out.push(`${phase}:${greenDirection}:${mode}`);
  }
  return out;
}

function assertValidState(snap) {
  const bad = [];
  (function walk(v, path) {
    if (v === undefined) bad.push(`${path} is undefined`);
    else if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${path} is ${v}`);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  }(snap, 'snapshot'));
  assert.deepEqual(bad, []);

  for (const d of DIRECTIONS) assert.ok(SIGNAL_VALUES.includes(snap.signals[d]), `signals.${d}=${snap.signals[d]}`);
  const nonRed = DIRECTIONS.filter((d) => snap.signals[d] !== 'RED');
  assert.ok(nonRed.length <= 1, `conflicting approaches: ${nonRed}`);
  assert.ok(snap.signal.greenDirection === null || DIRECTIONS.includes(snap.signal.greenDirection));
  assert.ok(['NORMAL', 'EMERGENCY', 'PEDESTRIAN', 'FALLBACK'].includes(snap.signal.mode));
  assert.ok(snap.signal.remainingTime === null || snap.signal.remainingTime >= 0);
}

// ------------------------------------------------------------------ Test 1

test('Test 1 - normal traffic: east has the highest demand and gets green', () => {
  const env = setup();
  const feed = () => input();
  env.svc.ingest(feed());

  const first = env.snap();
  // vehicles*2 + queueLength*2 + waitingTime*3
  assert.deepEqual(first.scores, { north: 85, south: 35, east: 136, west: 48 });
  assert.equal(first.signal.mode, 'NORMAL');

  env.advance(30, feed);
  const snap = env.snap();
  assert.equal(snap.signal.mode, 'NORMAL');
  assert.equal(snap.signal.greenDirection, 'east');
  assert.equal(snap.signal.phase, 'GREEN');
  assert.equal(snap.signal.greenTime, 40); // MIN 10 + queue 15 * 2s, capped at MAX 45
  assert.ok(snap.signal.remainingTime > 0 && snap.signal.remainingTime <= 40);
  assert.match(snap.signal.reason, /EAST has the highest traffic demand/);
  assert.deepEqual(snap.signals, { north: 'RED', south: 'RED', east: 'GREEN', west: 'RED' });
  // Original observations are preserved.
  assert.deepEqual(snap.traffic.east, {
    vehicles: 20, queueLength: 15, waiting: 22, waitingTime: 22, available: true, classes: null, confidence: null,
  });
  assertValidState(snap);
});

// ------------------------------------------------------------------ Test 2

test('Test 2 - emergency: ambulance north at 0.94 preempts to north', () => {
  const env = setup();
  const normal = () => input();
  env.svc.ingest(normal());
  env.advance(30, normal);
  assert.equal(env.snap().signal.greenDirection, 'east');

  const ambulance = () => input({ emergency: { detected: true, type: 'ambulance', direction: 'north', confidence: 0.94 } });
  env.svc.ingest(ambulance());
  let snap = env.snap();
  assert.equal(snap.signal.mode, 'EMERGENCY');
  assert.equal(snap.signal.phase, 'YELLOW', 'east is cleared through yellow, not cut straight to red');
  assert.equal(snap.signal.nextDirection, 'north');

  env.advance(5, ambulance);
  snap = env.snap();
  assert.equal(snap.signal.mode, 'EMERGENCY');
  assert.equal(snap.signal.greenDirection, 'north');
  assert.equal(snap.signals.north, 'GREEN');
  assert.equal(snap.signal.remainingTime, null, 'green is held while the emergency is present');
  assert.deepEqual(
    { detected: snap.emergency.detected, type: snap.emergency.type, direction: snap.emergency.direction, confidence: snap.emergency.confidence },
    { detected: true, type: 'ambulance', direction: 'north', confidence: 0.94 },
  );
  assert.match(snap.signal.reason, /Emergency priority - AMBULANCE on NORTH/);
  assertValidState(snap);
});

// ------------------------------------------------------------------ Test 3

test('Test 3 - low-confidence emergency (0.52) leaves normal logic unchanged', () => {
  const lowConf = { detected: true, type: 'ambulance', direction: 'north', confidence: 0.52 };
  const plain = setup();
  const weak = setup();

  const a = trace(plain, 120, () => input());
  const b = trace(weak, 120, () => input({ emergency: lowConf }));
  assert.deepEqual(b, a, 'decisions identical to the run without any detection');
  assert.ok(b.every((s) => !s.endsWith(':EMERGENCY')));

  const snap = weak.snap();
  assert.equal(snap.emergency.detected, false);
  assert.equal(snap.emergency.candidate.confidence, 0.52);
  assert.deepEqual(snap.emergency.observed, lowConf);
});

// ------------------------------------------------------------------ Test 4

test('Test 4 - balanced traffic is deterministic and rotates fairly', () => {
  const feed = () => input({ traffic: uniform({ vehicles: 5, queueLength: 4, waitingTime: 6 }) });
  const run1 = setup();
  const run2 = setup();
  const a = trace(run1, 200, feed);
  const b = trace(run2, 200, feed);
  assert.deepEqual(a, b);

  const scores = run1.snap().scores;
  assert.equal(new Set(Object.values(scores)).size, 1, 'all scores equal');
  const served = new Set(a.filter((s) => s.startsWith('GREEN:')).map((s) => s.split(':')[1]));
  assert.deepEqual([...served].sort(), [...DIRECTIONS].sort(), 'tie-break by longest red serves every approach');
});

// ------------------------------------------------------------------ Test 5

function untilPhase(env, phase, feed, maxSeconds = 90) {
  for (let i = 0; i < maxSeconds * 4; i += 1) {
    env.step(feed);
    if (env.snap().phase === phase) return;
  }
  assert.fail(`phase ${phase} never reached`);
}

test('Test 5 - an active pedestrian crossing is not interrupted by vehicle demand', () => {
  const env = setup();
  untilPhase(env, 'PED_WALK', () => input({ pedestrians: { south: true } }));
  const walkStart = env.now();
  let snap = env.snap();
  assert.equal(snap.signal.mode, 'PEDESTRIAN');
  assert.equal(snap.pedestrianSignals.south, 'WALK');

  // Heavy east demand arrives mid-crossing.
  const heavy = () => input({ traffic: { ...SPEC_TRAFFIC, east: { vehicles: 60, queueLength: 50, waitingTime: 90 } } });
  env.svc.ingest(heavy());
  for (;;) {
    env.step(heavy);
    snap = env.snap();
    if (DIRECTIONS.some((d) => snap.signals[d] !== 'RED')) break;
    assert.ok(['WALK', 'CLEARANCE'].includes(snap.pedestrianSignals.south));
    assertValidState(snap);
  }
  const allRedFor = (env.now() - walkStart) / 1000;
  const minimum = config.timing.MIN_PEDESTRIAN_CROSSING_TIME + config.timing.PEDESTRIAN_CLEARANCE_TIME;
  assert.ok(allRedFor >= minimum, `vehicles released after ${allRedFor}s, minimum is ${minimum}s`);
  assert.equal(snap.signal.greenDirection, 'east');
  assert.equal(snap.pedestrianSignals.south, 'DONT_WALK');
});

test('Test 5b - an emergency shortens WALK but pedestrian clearance still runs', () => {
  const env = setup();
  untilPhase(env, 'PED_WALK', () => input({ pedestrians: { south: true } }));

  const ambulance = () => input({ emergency: { detected: true, type: 'ambulance', direction: 'west', confidence: 0.95 } });
  env.svc.ingest(ambulance());
  const start = env.now();
  assert.equal(env.snap().phase, 'PED_CLEAR');
  while (env.snap().signals.west !== 'GREEN') {
    assert.ok(Object.values(env.snap().signals).every((v) => v === 'RED'));
    env.step(ambulance);
  }
  assert.ok((env.now() - start) / 1000 >= config.timing.PEDESTRIAN_CLEARANCE_TIME);
  assert.equal(env.snap().signal.mode, 'EMERGENCY');
});

// ------------------------------------------------------------------ Test 6

test('Test 6 - zero traffic never produces NaN, undefined or conflicting signals', () => {
  const env = setup();
  const feed = () => input({ traffic: uniform({ vehicles: 0, queueLength: 0, waitingTime: 0 }) });
  env.svc.ingest(feed());
  for (let s = 0; s < 120; s += 1) {
    env.advance(1, feed);
    const snap = env.snap();
    assertValidState(snap);
    assert.equal(snap.signal.mode, 'NORMAL');
  }
  assert.deepEqual(env.snap().scores, { north: 0, south: 0, east: 0, west: 0 });
});

test('malformed input fed directly to the engine is sanitised, not propagated as NaN', () => {
  const env = setup();
  env.svc.ingest({
    intersectionId: 'main',
    traffic: { north: { vehicles: 'lots', queueLength: -4, waitingTime: NaN }, east: { vehicles: 3 } },
    pedestrians: { south: 'yes' },
    emergency: { detected: true, type: 'ambulance', direction: 'up', confidence: 0.99 },
  });
  const snap = env.snap();
  assertValidState(snap);
  assert.deepEqual(snap.scores, { north: 0, south: 0, east: 6, west: 0 });
  assert.equal(snap.pedestrians.south, false);
  assert.equal(snap.emergency.detected, false, 'invalid direction cannot trigger emergency');
});

test('waiting and waitingTime are interchangeable inputs', () => {
  const a = normalizeObservation({ traffic: { north: { vehicles: 1, queueLength: 1, waiting: 9 } } });
  const b = normalizeObservation({ traffic: { north: { vehicles: 1, queueLength: 1, waitingTime: 9 } } });
  assert.deepEqual(a.traffic.north, b.traffic.north);
  assert.equal(a.traffic.north.waitingTime, 9);
});

// ---------------------------------------------------------------- Socket.IO

function fakeIo() {
  const handlers = {};
  const emitted = [];
  return {
    handlers,
    emitted,
    on(event, fn) { handlers[event] = fn; },
    // Events are sent to rooms; the room is recorded alongside each one.
    to(room) { return { emit: (event, data) => emitted.push({ event, data, room }) }; },
  };
}

function fakeSocket(sent, rooms = new Set()) {
  return {
    rooms,
    emit: (event, data) => sent.push({ event, data }),
    join: (room) => rooms.add(room),
    leave: (room) => rooms.delete(room),
    on() {},
  };
}

test('socket layer emits trafficUpdate with the complete state for each ingest', () => {
  const env = setup();
  const io = fakeIo();
  bindTrafficEvents(io, env.svc);

  env.svc.ingest(input());
  const updates = io.emitted.filter((e) => e.event === 'trafficUpdate');
  assert.equal(updates.length, 1);
  const state = updates[0].data;
  assert.equal(state.intersectionId, 'main');
  for (const key of ['traffic', 'signal', 'pedestrians', 'emergency', 'scores', 'signals']) assert.ok(key in state, key);
  for (const key of ['mode', 'greenDirection', 'greenTime', 'remainingTime', 'reason']) assert.ok(key in state.signal, key);
  assert.ok(io.emitted.some((e) => e.event === 'signalUpdate'));
  assert.ok(io.emitted.every((e) => e.room === 'live'), 'live engine events go to the live room only');
  assert.equal(state.dataMode, 'live');

  // Timer-only advances do not re-send trafficUpdate.
  env.advance(5);
  assert.equal(io.emitted.filter((e) => e.event === 'trafficUpdate').length, 1);

  const sent = [];
  const socket = fakeSocket(sent);
  io.handlers.connection(socket);
  assert.equal(sent[0].event, 'init');
  assert.equal(sent[0].data.dataMode, 'live');
  assert.deepEqual(sent[0].data.intersections.map((s) => s.intersectionId), ['main']);
  assert.deepEqual([...socket.rooms], ['live'], 'new clients start in the live room');
});
