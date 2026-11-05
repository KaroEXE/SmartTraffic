// Ingestion layer tests: POST /api/traffic -> validation -> trafficStateService -> GET.
// Runs a real Express app (real routes, controller, state service and the
// unmodified decision engine) on an ephemeral port. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const config = require('../config');
const simulationIntersections = require('../config/simulationIntersections');
const { createTrafficDecisionService } = require('../services/trafficDecisionService');
const { createTrafficStateService } = require('../services/trafficStateService');
const { createTrafficController } = require('../controllers/trafficController');
const { createSimulationController } = require('../controllers/simulationController');
const { createTrafficRoutes, createSimulationRoutes } = require('../routes/trafficRoutes');
const { createSimulationService } = require('../services/simulationService');
const { validateObservation } = require('./validation');
const SAMPLE = require('../test/fixtures/sampleTraffic.json');

// Two live intersections, so per-intersection storage can be tested; the
// server itself manages only the one in config/intersections.js.
const intersections = [
  { id: 'main', name: 'Main', lat: 0, lng: 0 },
  { id: 'second', name: 'Second', lat: 0, lng: 0 },
];
const sample = (overrides = {}) => ({ ...structuredClone(SAMPLE), timestamp: new Date().toISOString(), ...overrides });
// What the store keeps per approach: the fixture's values plus the optional fields.
const stored = (traffic) => Object.fromEntries(Object.entries(traffic)
  .map(([d, t]) => [d, t && { classes: null, confidence: null, ...t }]));

/** Mounted like server.js: /api/simulation (simulation channel) and /api (live channel). */
async function startApp({ history = null, ingestToken = '' } = {}) {
  const engine = createTrafficDecisionService({ intersections, config });
  const stateService = createTrafficStateService();
  const simulation = createSimulationService({
    intersections: simulationIntersections, config, generatorTickMs: 1e9, engineTickMs: 1e9,
  });
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/simulation', createSimulationRoutes(
    createTrafficController(simulation.engine, { stateService: simulation.stateService }),
    createSimulationController(simulation),
  ));
  app.use('/api', createTrafficRoutes(createTrafficController(engine, { stateService, history, ingestToken })));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: `No route ${req.method} ${req.originalUrl}` }));
  // Same JSON error handling as server.js
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.type === 'entity.parse.failed' ? 400 : 500).json({ ok: false, error: err.type || 'error' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (body, headers = { 'Content-Type': 'application/json' }) => {
    const res = await fetch(`${base}/traffic`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
  };
  const postTo = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  };
  const close = () => { simulation.reset(); return new Promise((r) => server.close(r)); };
  return { engine, stateService, simulation, post, postTo, get, close };
}

test('1. valid traffic data is stored and returned by GET', async () => {
  const app = await startApp();
  try {
    const before = await app.get('/traffic/observations/main');
    assert.equal(before.status, 404, 'nothing stored before any POST (no fake data)');
    assert.equal(before.body.received, false);

    const payload = sample();
    const res = await app.post(payload);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stored.sequence, 1);

    const got = await app.get('/traffic/observations/main');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.observation.traffic, stored(SAMPLE.traffic));
    assert.equal(got.body.observation.timestamp, payload.timestamp);
    assert.equal(got.body.observation.intersectionId, 'main');

    // Existing decision-engine endpoint still works and saw the same data.
    const decision = await app.get('/traffic/state/main');
    assert.equal(decision.body.state.traffic.east.vehicles, 20);
    assert.equal(decision.body.state.traffic.east.waiting, 22);

    const health = await app.get('/health');
    assert.equal(health.body.ok, true);
    assert.equal(health.body.ingestion.intersectionsWithData, 1);
  } finally { await app.close(); }
});

test('2. malformed traffic data is rejected with 4xx and never stored', async () => {
  const app = await startApp();
  try {
    const cases = [
      [{ ...sample(), intersectionId: undefined }, 400, /intersectionId/],
      [{ ...sample(), intersectionId: 'no spaces allowed' }, 400, /intersectionId/],
      [{ ...sample(), traffic: undefined }, 400, /traffic must be an object/],
      [{ ...sample(), traffic: { north: SAMPLE.traffic.north } }, 400, /traffic.south is required/],
      [{ ...sample(), traffic: { ...SAMPLE.traffic, northeast: SAMPLE.traffic.north } }, 400, /northeast is not a valid direction/],
      [{ ...sample(), traffic: { ...SAMPLE.traffic, east: { vehicles: -3, queueLength: 1, waitingTime: 2 } } }, 400, /east.vehicles must be between/],
      [{ ...sample(), traffic: { ...SAMPLE.traffic, east: { vehicles: '20', queueLength: 1, waitingTime: 2 } } }, 400, /east.vehicles must be a number/],
      [{ ...sample(), traffic: { ...SAMPLE.traffic, east: { vehicles: 2, queueLength: null, waitingTime: 2 } } }, 400, /east.queueLength must be a number/],
      [{ ...sample(), traffic: { ...SAMPLE.traffic, east: { vehicles: 2, queueLength: 1 } } }, 400, /east.waiting must be a number/],
      [{ ...sample(), timestamp: 'yesterday-ish' }, 400, /timestamp must be an ISO-8601/],
      [{ ...sample(), timestamp: 12345 }, 400, /timestamp/],
      [[1, 2, 3], 400, /JSON object/],
    ];
    for (const [body, status, pattern] of cases) {
      const res = await app.post(body);
      assert.equal(res.status, status, JSON.stringify(body).slice(0, 80));
      assert.match((res.body.details || [res.body.error]).join(' | '), pattern);
    }
    assert.equal((await app.post('{"intersectionId": "main", oops')).status, 400, 'broken JSON');
    assert.equal((await app.post(JSON.stringify(sample()), { 'Content-Type': 'text/plain' })).status, 415);
    const unknown = await app.post(sample({ intersectionId: 'nowhere' }));
    assert.equal(unknown.status, 404);
    assert.ok(unknown.body.knownIntersections.includes('main'));

    assert.equal(app.stateService.getAllTrafficStates().length, 0, 'nothing stored');
    assert.equal((await app.get('/health')).body.ok, true, 'server still healthy');
  } finally { await app.close(); }
});

test('3. emergency data: validated, stored, and given priority', async () => {
  const app = await startApp();
  try {
    const bad = [
      [{ detected: true, type: 'ambulance', direction: 'north', confidence: 1.4 }, /confidence must be a number between 0 and 1/],
      [{ detected: true, type: 'ambulance', direction: 'up', confidence: 0.9 }, /direction must be one of/],
      [{ detected: true, type: 'tank', direction: 'north', confidence: 0.9 }, /type must be one of/],
      [{ detected: 'yes' }, /detected must be a boolean/],
      [{ detected: true, type: 'ambulance', direction: 'north' }, /confidence/],
    ];
    for (const [emergency, pattern] of bad) {
      const res = await app.post(sample({ emergency }));
      assert.equal(res.status, 400);
      assert.match(res.body.details.join(' | '), pattern);
    }

    const ok = await app.post(sample());
    assert.equal(ok.status, 200);
    const obs = (await app.get('/traffic/observations/main')).body.observation;
    assert.deepEqual(obs.emergency, { detected: true, type: 'ambulance', direction: 'north', confidence: 0.94 });
    assert.equal(ok.body.decision.mode, 'EMERGENCY', 'decision engine received the emergency');

    // Not detected: direction null is valid.
    const none = await app.post(sample({ emergency: { detected: false, type: null, direction: null, confidence: 0 } }));
    assert.equal(none.status, 200);

    // Detected but direction unknown: stored with a warning, not prioritised.
    const app2 = await startApp();
    try {
      const noDir = await app2.post(sample({ emergency: { detected: true, type: 'police', direction: null, confidence: 0.9 } }));
      assert.equal(noDir.status, 200);
      assert.match(noDir.body.warnings[0], /without a direction/);
      assert.equal((await app2.get('/traffic/observations/main')).body.observation.emergency.type, 'police');
      assert.notEqual(noDir.body.decision.mode, 'EMERGENCY');
    } finally { await app2.close(); }
  } finally { await app.close(); }
});

test('4. pedestrian data: validated and stored', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.post(sample({ pedestrians: { south: 'yes' } }))).status, 400);
    assert.equal((await app.post(sample({ pedestrians: { diagonal: true } }))).status, 400);
    assert.equal((await app.post(sample({ pedestrians: [true] }))).status, 400);

    const res = await app.post(sample({ pedestrians: { south: true } }));
    assert.equal(res.status, 200);
    const obs = (await app.get('/traffic/observations/main')).body.observation;
    assert.deepEqual(obs.pedestrians, { north: false, south: true, east: false, west: false }, 'missing directions default to false');
    const decision = (await app.get('/traffic/state/main')).body.state;
    assert.equal(decision.pedestrianRequests.south, true, 'decision engine received the request');
  } finally { await app.close(); }
});

test('5. multiple intersections are stored independently', async () => {
  const app = await startApp();
  try {
    await app.post(sample({ intersectionId: 'main' }));
    const second = sample({ intersectionId: 'second', emergency: null });
    second.traffic.east.vehicles = 3;
    await app.post(second);

    const all = (await app.get('/traffic/observations')).body.observations;
    assert.deepEqual(all.map((o) => o.intersectionId).sort(), ['main', 'second']);
    assert.equal((await app.get('/traffic/observations/main')).body.observation.traffic.east.vehicles, 20);
    assert.equal((await app.get('/traffic/observations/second')).body.observation.traffic.east.vehicles, 3);
    assert.equal((await app.get('/traffic/observations/second')).body.observation.emergency.detected, false);
  } finally { await app.close(); }

  const fresh = await startApp();
  try {
    assert.equal((await fresh.get('/traffic/observations/second')).status, 404, 'no data -> nothing invented');
  } finally { await fresh.close(); }
});

test('6. repeated updates replace the state (no duplicates); stale ones are rejected', async () => {
  const app = await startApp();
  try {
    const t0 = Date.now();
    for (let i = 1; i <= 5; i += 1) {
      const p = sample({ timestamp: new Date(t0 + i * 1000).toISOString() });
      p.traffic.north.vehicles = i;
      const res = await app.post(p);
      assert.equal(res.status, 200);
      assert.equal(res.body.stored.sequence, i);
    }
    const all = (await app.get('/traffic/observations')).body.observations;
    assert.equal(all.length, 1, 'one state per intersection');
    assert.equal(all[0].traffic.north.vehicles, 5, 'latest update wins');
    assert.equal(all[0].sequence, 5);

    // An out-of-order request carrying an older capture time is not applied.
    const old = sample({ timestamp: new Date(t0 + 2000).toISOString() });
    old.traffic.north.vehicles = 99;
    const stale = await app.post(old);
    assert.equal(stale.status, 409);
    assert.equal((await app.get('/traffic/observations/main')).body.observation.traffic.north.vehicles, 5);

    // Updates without a timestamp are accepted and stamped on receipt.
    const noTs = sample({ timestamp: undefined });
    noTs.traffic.north.vehicles = 7;
    assert.equal((await app.post(noTs)).status, 200);
    const latest = (await app.get('/traffic/observations/main')).body.observation;
    assert.equal(latest.traffic.north.vehicles, 7);
    assert.equal(latest.timestamp, null);
    assert.ok(latest.receivedAt);
  } finally { await app.close(); }
});

test('legacy "waiting" field is accepted; simulated sources are rejected on live ingestion', async () => {
  const app = await startApp();
  try {
    const legacy = sample();
    for (const d of ['north', 'south', 'east', 'west']) {
      legacy.traffic[d] = { vehicles: 1, queueLength: 1, waiting: 9 };
    }
    assert.equal((await app.post(legacy)).status, 200);
    assert.equal((await app.get('/traffic/observations/main')).body.observation.traffic.north.waitingTime, 9);

    // "mock" / "simulation" are reserved: such data can never become live state.
    for (const source of ['mock', 'simulation', 'SIMULATION']) {
      const simulated = sample({ source });
      simulated.traffic.north.vehicles = 0;
      const res = await app.post(simulated);
      assert.equal(res.status, 422, source);
      assert.match(res.body.error, /reserved for simulated data/);
    }
    // ...and none of it was stored or reached the decision engine.
    const stored = (await app.get('/traffic/observations/main')).body.observation;
    assert.equal(stored.traffic.north.vehicles, 1);
    assert.equal(stored.sequence, 1);
    assert.equal(app.engine.getSnapshot('main').updatesReceived, 1);

    // Any other producer tag is a normal live source.
    assert.equal((await app.post(sample({ source: 'yolo-cam-1' }))).status, 200);
  } finally { await app.close(); }
});

test('validator never throws on hostile input', () => {
  const inputs = [undefined, null, 0, 'x', [], {}, { traffic: null }, { traffic: { north: [] } },
    { intersectionId: 'main', traffic: { north: { vehicles: Infinity } } },
    { intersectionId: 'main', traffic: SAMPLE.traffic, emergency: [] },
    { intersectionId: 'main', traffic: SAMPLE.traffic, pedestrians: 'all' },
    JSON.parse('{"__proto__": {"polluted": true}, "intersectionId": "main"}')];
  for (const input of inputs) {
    const r = validateObservation(input);
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
  }
  assert.equal({}.polluted, undefined);
});

// ------------------------------------------------------- simulation channel

test('simulation API: start / pause / reset change only simulated state', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.post(sample())).status, 200); // one real observation
    const liveBefore = (await app.get('/traffic/state/main')).body.state;

    assert.equal((await app.get('/simulation/status')).body.state, 'stopped');
    const started = await app.postTo('/simulation/start');
    assert.equal(started.status, 200);
    assert.equal(started.body.state, 'running');

    const simState = (await app.get('/simulation/traffic/state/main')).body.state;
    assert.equal(simState.dataMode, 'simulation');
    assert.ok(simState.updatesReceived >= 1);
    assert.ok((await app.get('/simulation/traffic/state')).body.intersections.every((s) => s.dataMode === 'simulation'));
    assert.ok((await app.get('/simulation/intersections')).body.intersections.every((i) => i.dataMode === 'simulation'));

    // Scenario control is validated and scoped to the simulation.
    assert.equal((await app.postTo('/simulation/scenario', { intersectionId: 'main', scenario: 'ambulance-north' })).status, 200);
    assert.equal((await app.postTo('/simulation/scenario', { intersectionId: 'main', scenario: 'meteor' })).status, 400);
    assert.equal((await app.postTo('/simulation/scenario', { intersectionId: 'nowhere', scenario: 'normal' })).status, 404);
    assert.equal((await app.postTo('/simulation/scenario', { intersectionId: 5 })).status, 400);
    assert.equal((await app.postTo('/simulation/tour', { intersectionId: 'main', enabled: 'yes' })).status, 400);

    assert.equal((await app.postTo('/simulation/pause')).body.state, 'paused');
    assert.equal((await app.postTo('/simulation/reset')).body.state, 'stopped');
    assert.equal((await app.get('/simulation/traffic/state/main')).body.state.updatesReceived, 0);

    // Live: exactly as before the simulation ran.
    const liveAfter = (await app.get('/traffic/state/main')).body.state;
    assert.equal(liveAfter.dataMode, 'live');
    assert.equal(liveAfter.updatesReceived, liveBefore.updatesReceived);
    assert.equal(liveAfter.emergency.active, liveBefore.emergency.active);
    assert.equal((await app.get('/traffic/observations/main')).body.observation.sequence, 1);
    assert.equal(app.stateService.getAllTrafficStates().length, 1);
  } finally { await app.close(); }
});

test('simulated observations cannot be ingested over HTTP on either channel', async () => {
  const app = await startApp();
  try {
    // The simulation channel has no ingestion route at all...
    const simPost = await app.postTo('/simulation/traffic', sample());
    assert.equal(simPost.status, 404);
    assert.equal((await app.get('/simulation/traffic/observations')).status, 404);
    assert.equal((await app.get('/simulation/history/traffic')).status, 404);
    // ...and live ingestion refuses data tagged as simulated.
    assert.equal((await app.post(sample({ source: 'simulation' }))).status, 422);
    assert.equal(app.simulation.engine.getSnapshot('main').updatesReceived, 0);
    assert.equal(app.engine.getSnapshot('main').updatesReceived, 0);
  } finally { await app.close(); }
});

test('history API: one mode per query, validated parameters, safe without a database', async () => {
  const calls = [];
  const fakeHistory = {
    findTrafficRecords: async (options) => { calls.push(['traffic', options]); return [{ dataMode: options.mode }]; },
    findSignalEvents: async (options) => { calls.push(['signals', options]); return []; },
  };
  const app = await startApp({ history: fakeHistory });
  try {
    const live = await app.get('/history/traffic?intersectionId=main&from=2026-10-08T00:00:00Z&limit=5');
    assert.equal(live.status, 200);
    assert.equal(live.body.mode, 'live', 'live is the default');
    assert.deepEqual(calls.at(-1), ['traffic', {
      mode: 'live', intersectionId: 'main', from: '2026-10-08T00:00:00.000Z', limit: 5,
    }]);

    const sim = await app.get('/history/signals?mode=simulation');
    assert.equal(sim.status, 200);
    assert.deepEqual(calls.at(-1), ['signals', { mode: 'simulation' }]);

    for (const bad of [
      '?mode=all', '?mode=', '?intersectionId[$ne]=x', '?intersectionId=no%20spaces', '?from=yesterday',
      '?limit=0', '?limit=2.5', '?limit=1&limit=2',
    ]) {
      const res = await app.get(`/history/traffic${bad}`);
      assert.equal(res.status, 400, bad);
    }
    assert.equal(calls.length, 2, 'invalid queries never reach the database');

    fakeHistory.findTrafficRecords = async () => { throw Object.assign(new Error('x'), { code: 'DB_UNAVAILABLE' }); };
    assert.equal((await app.get('/history/traffic')).status, 503);
  } finally { await app.close(); }

  const noDb = await startApp();
  try {
    const res = await noDb.get('/history/traffic');
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not configured/);
  } finally { await noDb.close(); }
});

// ------------------------------------------------- AI service contract

test('an approach without a camera video is accepted as unavailable, never as zero', async () => {
  const app = await startApp();
  try {
    const payload = sample({ emergency: undefined, pedestrians: undefined });
    payload.traffic.west = null;
    payload.traffic.north = { ...payload.traffic.north, classes: { car: 10, bus: 2 }, confidence: 0.71 };
    const res = await app.post(payload);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const obs = (await app.get('/traffic/observations/main')).body.observation;
    assert.equal(obs.traffic.west, null);
    assert.deepEqual(obs.traffic.north.classes, { car: 10, bus: 2 });
    assert.equal(obs.traffic.north.confidence, 0.71);
    assert.deepEqual(obs.detectors, { pedestrians: false, emergency: false }, 'omitted detectors are "not measured"');

    const state = (await app.get('/traffic/state/main')).body.state;
    assert.deepEqual(state.traffic.west, {
      vehicles: null, queueLength: null, waiting: null, waitingTime: null, available: false, classes: null, confidence: null,
    });
    assert.equal(state.traffic.north.available, true);
    assert.equal(state.traffic.north.vehicles, 12);
    assert.deepEqual(state.traffic.north.classes, { car: 10, bus: 2 });
    assert.deepEqual(state.detectors, { pedestrians: false, emergency: false });
    assert.ok(state.events.some((e) => /WEST camera unavailable/.test(e.message)));

    const allMissing = sample();
    for (const d of Object.keys(allMissing.traffic)) allMissing.traffic[d] = null;
    const rejected = await app.post(allMissing);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.details.join(' | '), /at least one available approach/);

    for (const [field, value] of [['classes', { Car: 1 }], ['classes', { car: -1 }], ['classes', [1]], ['confidence', 2]]) {
      const bad = sample();
      bad.traffic.north[field] = value;
      assert.equal((await app.post(bad)).status, 400, `${field}=${JSON.stringify(value)}`);
    }
  } finally { await app.close(); }
});

test('the AI service generic "emergency" type is accepted', async () => {
  const app = await startApp();
  try {
    const res = await app.post(sample({ emergency: { detected: true, type: 'emergency', direction: 'west', confidence: 0.85 } }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.decision.mode, 'EMERGENCY');
  } finally { await app.close(); }
});

test('with TRAFFIC_INGEST_TOKEN set, only the AI service can post traffic', async () => {
  const app = await startApp({ ingestToken: 'shared-secret' });
  try {
    const json = { 'Content-Type': 'application/json' };
    const missing = await app.post(sample());
    assert.equal(missing.status, 401);
    const wrong = await app.post(sample(), { ...json, Authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    assert.equal(app.stateService.getAllTrafficStates().length, 0, 'nothing stored from unauthorized requests');
    const right = await app.post(sample(), { ...json, Authorization: 'Bearer shared-secret' });
    assert.equal(right.status, 200);
    assert.equal((await app.get('/health')).body.ingestion.tokenRequired, true);
  } finally { await app.close(); }
});
