const test = require('node:test');
const assert = require('node:assert/strict');

const TrafficRecord = require('../models/TrafficRecord');
const SignalEvent = require('../models/SignalEvent');
const { safeMessage } = require('../config/database');
const { createTrafficHistoryService } = require('./trafficHistoryService');
const { createTrafficDecisionService } = require('./trafficDecisionService');
const { createTrafficStateService } = require('./trafficStateService');
const { validateObservation } = require('../utils/validation');

// No database needed: models are replaced by recorders, and every document
// produced is checked against the real mongoose schema with validateSync().

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

function fakeModel() {
  const docs = [];
  return { docs, create: async (doc) => { docs.push(doc); return doc; } };
}

function setup({ connected = true, dataMode } = {}) {
  let t = Date.parse('2026-10-08T12:00:00Z');
  const now = () => t;
  const decisionService = createTrafficDecisionService({
    intersections: [{ id: 'main', name: 'Main', lat: 0, lng: 0 }],
    config,
    now,
  });
  const stateService = createTrafficStateService({ now });
  const records = fakeModel();
  const events = fakeModel();
  const warnings = [];
  const history = createTrafficHistoryService({
    stateService,
    decisionService,
    TrafficRecord: records,
    SignalEvent: events,
    isConnected: () => connected,
    log: { warn: (m) => warnings.push(m) },
    ...(dataMode ? { dataMode } : {}),
  }).start();

  // Same path as POST /api/traffic: validate -> store -> decision engine.
  const post = (body) => {
    const result = validateObservation(body);
    assert.ok(result.ok, JSON.stringify(result.errors));
    const stored = stateService.setTrafficState(result.value);
    if (stored.stored) decisionService.ingest(result.value);
    return stored;
  };
  const advance = (seconds, feed) => {
    for (let i = 0; i < seconds * 4; i += 1) {
      t += 250;
      if (feed && i % 4 === 0) post(feed());
      decisionService.tick();
    }
  };
  decisionService.tick(); // initial state, as server.js does via start()
  return { history, records, events, warnings, post, advance, now };
}

function observation(overrides = {}) {
  return {
    intersectionId: 'main',
    source: 'mock',
    traffic: {
      north: { vehicles: 12, queueLength: 8, waitingTime: 15 },
      south: { vehicles: 4, queueLength: 3, waitingTime: 7 },
      east: { vehicles: 20, queueLength: 15, waitingTime: 22.5 },
      west: { vehicles: 5, queueLength: 4, waitingTime: 10 },
    },
    pedestrians: { south: true },
    emergency: { detected: true, type: 'ambulance', direction: 'north', confidence: 0.52 },
    ...overrides,
  };
}

function assertValid(Model, doc) {
  const err = new Model(doc).validateSync();
  assert.equal(err, undefined, err && err.message);
}

// ---------------------------------------------------------------- records

test('an accepted observation becomes one schema-valid TrafficRecord', async () => {
  const env = setup();
  env.post(observation({ timestamp: '2026-10-08T11:59:59.500Z' }));
  await env.history.flush();

  assert.equal(env.records.docs.length, 1);
  const doc = env.records.docs[0];
  assertValid(TrafficRecord, doc);
  assert.ok(doc.timestamp instanceof Date);
  assert.equal(doc.timestamp.toISOString(), '2026-10-08T11:59:59.500Z', 'producer capture time');
  assert.equal(doc.receivedAt.toISOString(), '2026-10-08T12:00:00.000Z', 'server receive time');
  assert.equal(doc.source, 'mock');
  assert.deepEqual(doc.traffic.east, { vehicles: 20, queueLength: 15, waitingTime: 22.5 });
  assert.deepEqual(doc.pedestrians, { north: false, south: true, east: false, west: false });
  assert.deepEqual(doc.emergency, { detected: true, type: 'ambulance', direction: 'north', confidence: 0.52 });
  // Signal state in effect when the observation arrived (startup: fixed-time, north green).
  assert.equal(doc.signal.mode, 'FALLBACK');
  assert.equal(doc.signal.signals.north, 'GREEN');
  assert.equal(env.history.stats().trafficRecordsSaved, 1);
});

test('receive time is used when the producer sends no timestamp', async () => {
  const env = setup();
  env.post(observation());
  await env.history.flush();
  assert.equal(env.records.docs[0].timestamp.toISOString(), env.records.docs[0].receivedAt.toISOString());
});

test('history accumulates; the same capture posted twice is stored once', async () => {
  const env = setup();
  env.post(observation({ timestamp: '2026-10-08T12:00:00Z' }));
  env.post(observation({ timestamp: '2026-10-08T12:00:00Z' })); // retry of the same capture
  env.post(observation({ timestamp: '2026-10-08T12:00:01Z' }));
  env.post(observation({ timestamp: '2026-10-08T12:00:02Z' }));
  await env.history.flush();
  assert.deepEqual(
    env.records.docs.map((d) => d.timestamp.toISOString()),
    ['2026-10-08T12:00:00.000Z', '2026-10-08T12:00:01.000Z', '2026-10-08T12:00:02.000Z'],
  );
});

test('rejected observations are not recorded', async () => {
  const env = setup();
  env.post(observation({ timestamp: '2026-10-08T12:00:05Z' }));
  const stale = env.post(observation({ timestamp: '2026-10-08T12:00:01Z' }));
  assert.equal(stale.stored, false);
  await env.history.flush();
  assert.equal(env.records.docs.length, 1);
});

// ----------------------------------------------------------------- events

test('phase changes become SignalEvents with from/to, reason and durations', async () => {
  const env = setup();
  const feed = () => observation({ pedestrians: {}, emergency: null });
  env.advance(40, feed);
  await env.history.flush();

  assert.ok(env.events.docs.length >= 3, `events: ${env.events.docs.length}`);
  for (const doc of env.events.docs) assertValid(SignalEvent, doc);

  const [toYellow, toAllRed, toGreen] = env.events.docs;
  assert.equal(toYellow.previousPhase, 'GREEN');
  assert.equal(toYellow.phase, 'YELLOW');
  assert.deepEqual(toYellow.changes, [{ direction: 'north', kind: 'vehicle', from: 'GREEN', to: 'YELLOW' }]);
  assert.equal(toYellow.previousPhaseDuration, 20, 'fixed-time north green lasted 20 s');
  assert.match(toYellow.reason, /EAST has the highest traffic demand/);

  assert.equal(toAllRed.phase, 'ALL_RED');
  assert.equal(toAllRed.previousPhaseDuration, 3, 'yellow lasted YELLOW_TIME');

  assert.equal(toGreen.phase, 'GREEN');
  assert.deepEqual(toGreen.changes, [{ direction: 'east', kind: 'vehicle', from: 'RED', to: 'GREEN' }]);
  assert.equal(toGreen.plannedDuration, 40, 'engine plan: 10 s + 15 queued x 2 s');
  assert.equal(toGreen.timestamp.getTime() - toAllRed.timestamp.getTime(), 1000, 'all-red lasted 1 s');
});

test('fixed-time cycling without a perception feed is not recorded', async () => {
  const env = setup();
  env.advance(120);
  await env.history.flush();
  assert.equal(env.events.docs.length, 0);
});

// ---------------------------------------------------------------- failures

test('while the database is down nothing is written and the loss is reported', async () => {
  const env = setup({ connected: false });
  env.advance(30, () => observation({ emergency: null }));
  await env.history.flush();
  assert.equal(env.records.docs.length, 0);
  assert.equal(env.events.docs.length, 0);
  assert.ok(env.history.stats().notSaved >= 30);
  assert.equal(env.warnings.length, 1, 'warned once, not per record');
  assert.match(env.warnings[0], /not being saved/);
});

test('a failed write is counted and logged, never thrown into ingestion', async () => {
  const env = setup();
  env.history.TrafficRecord = { create: async () => { throw Object.assign(new Error('E11000 write failed'), { name: 'MongoServerError' }); } };
  env.post(observation());
  await env.history.flush();
  assert.equal(env.history.stats().notSaved, 1);
  assert.match(env.warnings[0], /Traffic record could not be saved/);
});

test('schemas reject invalid records', () => {
  const bad = new TrafficRecord({
    intersectionId: 'main',
    receivedAt: 'not a date',
    traffic: { north: { vehicles: -1, queueLength: 'x', waitingTime: 1 } },
    emergency: { detected: true, type: 'tank', confidence: 2 },
    signal: { mode: 'PARTY', phase: 'GREEN' },
  }).validateSync();
  assert.ok(bad);
  for (const path of [
    'timestamp', 'receivedAt', 'traffic.north.vehicles', 'traffic.north.queueLength',
    'pedestrians.north', 'emergency.type', 'emergency.confidence', 'signal.mode', 'signal.signals.north',
  ]) {
    assert.ok(bad.errors[path], `expected an error on ${path}; got ${Object.keys(bad.errors)}`);
  }
});

test('connection errors are logged without credentials', () => {
  const uri = 'mongodb+srv://trafficUser:s3cr3t@cluster0.example.mongodb.net/smart-traffic';
  const msg = safeMessage(new Error(`bad auth for ${uri} (user trafficUser:s3cr3t)`), uri);
  assert.doesNotMatch(msg, /s3cr3t|trafficUser/);
  assert.match(msg, /<MONGODB_URI>/);
});

// -------------------------------------------------------------- data modes

const { createSimulationService } = require('./simulationService');


/**
 * In-memory stand-in for a mongoose model: create() appends, find() applies
 * the subset of MongoDB query operators the history queries use, with
 * MongoDB's semantics for missing fields ($ne / $nin match a missing field).
 */
function queryModel(docs = []) {
  const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return cond.some((f) => matches(doc, f));
    const v = doc[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return v === cond;
    return Object.entries(cond).every(([op, x]) => {
      if (op === '$ne') return v !== x;
      if (op === '$in') return x.includes(v);
      if (op === '$nin') return !x.includes(v === undefined ? null : v);
      if (op === '$gte') return v >= x;
      if (op === '$lte') return v <= x;
      throw new Error(`fake model: unsupported operator ${op}`);
    });
  });
  const calls = [];
  return {
    docs,
    calls,
    create: async (doc) => { docs.push(doc); return doc; },
    find(filter) {
      calls.push(filter);
      let rows = docs.filter((d) => matches(d, filter));
      const chain = {
        sort(spec) {
          const [[k, dir]] = Object.entries(spec);
          rows = rows.slice().sort((a, b) => (a[k] - b[k]) * dir);
          return chain;
        },
        limit(n) { rows = rows.slice(0, n); return chain; },
        lean: async () => rows,
      };
      return chain;
    },
  };
}

test('each history instance stamps its own dataMode; a request cannot choose it', async () => {
  const live = setup();
  const sim = setup({ dataMode: 'simulation' });

  live.post(observation({ source: null, emergency: null, timestamp: '2026-10-08T11:59:00Z' }));
  // A producer trying to label its own data is ignored (unknown fields are dropped).
  sim.post(observation({ source: 'simulation', dataMode: 'live', emergency: null, timestamp: '2026-10-08T11:59:00Z' }));
  const feed = () => observation({ source: 'simulation', pedestrians: {}, emergency: null });
  sim.advance(40, feed);
  await live.history.flush();
  await sim.history.flush();

  assert.equal(live.records.docs[0].dataMode, 'live');
  assertValid(TrafficRecord, live.records.docs[0]);
  assert.ok(sim.records.docs.length > 1);
  for (const doc of sim.records.docs) {
    assert.equal(doc.dataMode, 'simulation');
    assertValid(TrafficRecord, doc);
  }
  assert.ok(sim.events.docs.length > 0);
  for (const doc of sim.events.docs) {
    assert.equal(doc.dataMode, 'simulation');
    assertValid(SignalEvent, doc);
  }
  assert.throws(() => createTrafficHistoryService({ dataMode: 'replay' }), /Unknown data mode/);
});

test('history queries return exactly one mode; legacy rows are classified safely', async () => {
  const at = (s) => new Date(`2026-10-08T12:00:0${s}Z`);
  const docs = [
    { id: 'live', dataMode: 'live', source: null, intersectionId: 'main', timestamp: at(1) },
    { id: 'sim', dataMode: 'simulation', source: 'simulation', intersectionId: 'main', timestamp: at(2) },
    { id: 'legacy', source: null, intersectionId: 'main', timestamp: at(3) }, // written before dataMode existed
    { id: 'legacy-mock', source: 'mock', intersectionId: 'main', timestamp: at(4) }, // old mock-client rows
    { id: 'live-2', dataMode: 'live', source: 'yolo-cam-1', intersectionId: 'second', timestamp: at(5) },
    { id: 'mislabelled', dataMode: 'live', source: 'mock', intersectionId: 'main', timestamp: at(6) },
  ];
  let connected = true;
  const history = createTrafficHistoryService({
    TrafficRecord: queryModel(docs), SignalEvent: queryModel(docs), isConnected: () => connected,
  });
  const ids = async (options) => (await history.findTrafficRecords(options)).map((d) => d.id);

  assert.deepEqual(await ids({}), ['live-2', 'legacy', 'live'], 'default is live, newest first');
  assert.deepEqual(await ids({ mode: 'live' }), ['live-2', 'legacy', 'live']);
  assert.deepEqual(await ids({ mode: 'simulation' }), ['mislabelled', 'legacy-mock', 'sim'],
    'anything tagged as simulated is never returned as live');
  // The two modes partition the data: nothing in both, nothing lost.
  const liveIds = await ids({ mode: 'live' });
  const simIds = await ids({ mode: 'simulation' });
  assert.equal(liveIds.filter((id) => simIds.includes(id)).length, 0);
  assert.equal(liveIds.length + simIds.length, docs.length);

  assert.deepEqual(await ids({ mode: 'live', intersectionId: 'main' }), ['legacy', 'live']);
  assert.deepEqual(await ids({ mode: 'live', from: at(2).toISOString(), to: at(4).toISOString() }), ['legacy']);
  assert.deepEqual(await ids({ mode: 'live', limit: 1 }), ['live-2']);
  assert.deepEqual((await history.findSignalEvents({ mode: 'simulation', limit: 1 })).map((d) => d.id), ['mislabelled']);

  await assert.rejects(history.findTrafficRecords({ mode: 'all' }), /Unknown data mode/);
  await assert.rejects(history.findTrafficRecords({ intersectionId: { $ne: 'x' } }), /must be a string/);
  await assert.rejects(history.findTrafficRecords({ from: 'yesterday' }), /valid dates/);
  connected = false;
  await assert.rejects(history.findTrafficRecords({}), (err) => err.code === 'DB_UNAVAILABLE');
});

test('server wiring: live observations are saved as live records, unavailable approaches as null', async () => {
  let t = Date.parse('2026-10-09T09:00:00Z');
  const records = queryModel();
  const events = queryModel();
  const common = { TrafficRecord: records, SignalEvent: events, isConnected: () => true, log: { warn() {} } };
  const intersections = [{ id: 'main', name: 'Main', lat: 0, lng: 0 }];

  // As in server.js.
  const engine = createTrafficDecisionService({ intersections, config, now: () => t });
  const state = createTrafficStateService({ now: () => t });
  const history = createTrafficHistoryService({ stateService: state, decisionService: engine, ...common }).start();

  for (let s = 0; s < 60; s += 1) {
    for (let q = 0; q < 4; q += 1) {
      t += 250;
      engine.tick();
    }
    if (s % 5 === 0) {
      const body = { ...observation({ source: 'python-ai', emergency: null }), timestamp: new Date(t).toISOString() };
      if (s === 30) body.traffic = { ...body.traffic, west: null }; // west camera video unavailable
      const r = validateObservation(body);
      assert.ok(r.ok, JSON.stringify(r.errors));
      if (state.setTrafficState(r.value).stored) engine.ingest(r.value);
    }
  }
  await history.flush();

  const saved = await history.findTrafficRecords({ mode: 'live', limit: 1000 });
  assert.equal(saved.length, 12, 'exactly the 12 real observations');
  assert.equal(records.docs.length, 12, 'nothing else was written');
  for (const doc of saved) {
    assert.equal(doc.dataMode, 'live');
    assertValid(TrafficRecord, doc);
  }
  assert.equal(saved.filter((d) => d.traffic.west === null).length, 1);
  assert.ok(events.docs.length > 0);
  assert.ok(events.docs.every((d) => d.dataMode === 'live'));
});

test('server wiring: a running simulation writes only simulation history, live only live', async () => {
  let t = Date.parse('2026-10-09T09:00:00Z');
  const records = queryModel();
  const events = queryModel();
  const common = { TrafficRecord: records, SignalEvent: events, isConnected: () => true, log: { warn() {} } };
  const intersections = [{ id: 'main', name: 'Main', lat: 0, lng: 0 }];

  // Live channel, as in server.js.
  const liveEngine = createTrafficDecisionService({ intersections, config, now: () => t });
  const liveState = createTrafficStateService({ now: () => t });
  const liveHistory = createTrafficHistoryService({ stateService: liveState, decisionService: liveEngine, ...common }).start();

  // Simulation channel, as in server.js.
  let seed = 3;
  const sim = createSimulationService({
    intersections,
    config,
    real: () => t,
    generatorTickMs: 1e9,
    engineTickMs: 1e9,
    random: () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; },
  });
  const simHistory = createTrafficHistoryService({
    stateService: sim.stateService, decisionService: sim.engine, dataMode: 'simulation', ...common,
  }).start();
  sim.on('reset', () => simHistory.resetTracking());

  sim.start();
  sim.setScenario('main', 'heavy-east');
  for (let s = 0; s < 60; s += 1) {
    for (let q = 0; q < 4; q += 1) {
      t += 250;
      sim.engine.tick();
      liveEngine.tick();
    }
    sim.tick();
    if (s % 5 === 0) {
      const r = validateObservation({ ...observation({ source: null, emergency: null }), timestamp: new Date(t).toISOString() });
      if (liveState.setTrafficState(r.value).stored) liveEngine.ingest(r.value);
    }
  }
  sim.reset();
  await liveHistory.flush();
  await simHistory.flush();

  const liveRecords = await liveHistory.findTrafficRecords({ mode: 'live', limit: 1000 });
  const simRecords = await liveHistory.findTrafficRecords({ mode: 'simulation', limit: 1000 });
  assert.equal(liveRecords.length, 12, 'exactly the 12 real observations');
  assert.ok(liveRecords.every((d) => d.dataMode === 'live' && d.source === null));
  assert.equal(simRecords.length, records.docs.length - 12);
  assert.ok(simRecords.length >= 60);
  assert.ok(simRecords.every((d) => d.dataMode === 'simulation' && d.source === 'simulation'));
  const simEvents = await simHistory.findSignalEvents({ mode: 'simulation', limit: 1000 });
  const liveEvents = await simHistory.findSignalEvents({ mode: 'live', limit: 1000 });
  assert.ok(simEvents.length > 0);
  assert.ok(simEvents.every((d) => d.dataMode === 'simulation'));
  assert.ok(liveEvents.every((d) => d.dataMode === 'live'));
  assert.equal(simEvents.length + liveEvents.length, events.docs.length);
});
