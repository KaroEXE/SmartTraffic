const test = require('node:test');
const assert = require('node:assert/strict');

const { createSimulationService, createPausableClock } = require('./simulationService');
const { createTrafficDecisionService } = require('./trafficDecisionService');
const { createTrafficStateService } = require('./trafficStateService');
const { validateObservation, toDecisionInput } = require('../utils/validation');

// No timers, no network: the clock is manual, random is seeded, and the
// generator/engine are stepped by hand exactly as their intervals would.

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

const INTERSECTIONS = [
  { id: 'main', name: 'Main', lat: 0, lng: 0 },
  { id: 'second', name: 'Second', lat: 0, lng: 0 },
];

function seeded(seed = 7) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
}

function setup() {
  let t = Date.parse('2026-10-09T09:00:00Z');
  const real = () => t;

  // A live channel built exactly like server.js builds it.
  const liveNow = () => t;
  const live = createTrafficDecisionService({ intersections: INTERSECTIONS, config, now: liveNow });
  const liveState = createTrafficStateService({ now: liveNow });
  // Control twin: same inputs and ticks as `live`, but no simulation beside it.
  const control = createTrafficDecisionService({ intersections: INTERSECTIONS, config, now: liveNow });
  const controlState = createTrafficStateService({ now: liveNow });
  const postLive = (body) => {
    const r = validateObservation(body);
    assert.ok(r.ok, JSON.stringify(r.errors));
    if (liveState.setTrafficState(r.value).stored) live.ingest(toDecisionInput(r.value));
    if (controlState.setTrafficState(r.value).stored) control.ingest(toDecisionInput(r.value));
  };

  // Huge interval: the real timers never fire during a test.
  const sim = createSimulationService({
    intersections: INTERSECTIONS, config, real, random: seeded(), generatorTickMs: 1e9, engineTickMs: 1e9,
  });
  const events = { status: [], reset: [] };
  sim.on('status', (s) => events.status.push(s.state));
  sim.on('reset', (snaps) => events.reset.push(snaps));

  /** Advance wall time; step the simulation as its timers would (engine 4x/s, generator 1x/s). */
  const advance = (seconds) => {
    for (let i = 0; i < seconds * 4; i += 1) {
      t += 250;
      if (sim.state === 'running') sim.engine.tick();
      if (i % 4 === 3) sim.tick();
      live.tick();
      control.tick();
    }
  };
  return { sim, live, liveState, control, postLive, advance, events, real };
}

const liveTraffic = () => ({
  intersectionId: 'main',
  traffic: {
    north: { vehicles: 3, queueLength: 2, waitingTime: 5 },
    south: { vehicles: 2, queueLength: 1, waitingTime: 4 },
    east: { vehicles: 9, queueLength: 6, waitingTime: 8 },
    west: { vehicles: 1, queueLength: 0, waitingTime: 2 },
  },
});

/** Complete live state, including its event log. */
const liveFingerprint = (engine) => JSON.stringify(engine.ids().map((id) => engine.getSnapshot(id, { includeEvents: true })));

test('simulation is idle until started and creates no timers', () => {
  const { sim, liveState } = setup();
  assert.equal(sim.state, 'stopped');
  assert.equal(sim.timer, null);
  assert.equal(sim.engine.timer, null);
  assert.equal(sim.stateService.getAllTrafficStates().length, 0);
  for (const snap of sim.engine.getAllSnapshots()) {
    assert.equal(snap.dataMode, 'simulation');
    assert.equal(snap.aiStatus, 'WAITING');
  }
  assert.equal(liveState.getAllTrafficStates().length, 0);
});

test('start generates tagged observations into its own engine and store only', () => {
  const env = setup();
  env.postLive(liveTraffic());
  const liveBefore = env.live.getSnapshot('main');

  env.sim.start();
  env.advance(10);

  const states = env.sim.stateService.getAllTrafficStates();
  assert.deepEqual(states.map((s) => s.intersectionId).sort(), ['main', 'second']);
  assert.ok(states.every((s) => s.source === 'simulation'), 'simulated data is tagged');
  const simSnap = env.sim.engine.getSnapshot('main');
  assert.equal(simSnap.dataMode, 'simulation');
  assert.equal(simSnap.aiStatus, 'CONNECTED');
  assert.ok(simSnap.updatesReceived >= 10);

  // Live: still exactly the one real observation.
  assert.equal(env.liveState.getAllTrafficStates().length, 1);
  assert.equal(env.liveState.getTrafficState('main').sequence, 1);
  assert.equal(env.live.getSnapshot('main').updatesReceived, liveBefore.updatesReceived);
  assert.equal(env.live.getSnapshot('second').aiStatus, 'WAITING');
  assert.ok(env.live.getAllSnapshots().every((s) => s.dataMode === 'live'));
  env.sim.reset();
});

test('a simulated emergency preempts only the simulation engine, never live', () => {
  const env = setup();
  env.postLive(liveTraffic());
  env.sim.start();
  env.sim.setScenario('main', 'ambulance-north');
  let simEmergency = false;
  for (let s = 0; s < 30; s += 1) {
    env.advance(1);
    env.postLive(liveTraffic()); // live keeps receiving normal real data
    if (env.sim.engine.getSnapshot('main').mode === 'EMERGENCY') simEmergency = true;
    const live = env.live.getSnapshot('main');
    assert.notEqual(live.mode, 'EMERGENCY');
    assert.equal(live.emergency.active, false);
    assert.equal(live.emergency.observed.detected, false);
  }
  assert.ok(simEmergency, 'simulation engine did enter emergency mode');
  assert.equal(liveFingerprint(env.live), liveFingerprint(env.control), 'live signals identical to a twin with no simulation');
  env.sim.reset();
});

test('pause freezes the simulation clock and generator; start resumes where it stopped', () => {
  const env = setup();
  env.sim.start();
  env.advance(12);
  env.sim.pause();
  assert.equal(env.sim.state, 'paused');
  assert.equal(env.sim.timer, null);
  assert.equal(env.sim.engine.timer, null);

  const frozen = env.sim.engine.getSnapshot('main');
  const clockAtPause = env.sim.clock.now();
  env.advance(60); // a minute of wall time while paused
  const still = env.sim.engine.getSnapshot('main');
  assert.equal(env.sim.clock.now(), clockAtPause, 'simulation time does not move while paused');
  assert.equal(still.updatesReceived, frozen.updatesReceived, 'no observations while paused');
  assert.equal(still.phase, frozen.phase);
  assert.equal(still.remaining, frozen.remaining);
  assert.equal(still.aiStatus, 'CONNECTED', 'pausing is not a lost feed');

  env.sim.start();
  assert.equal(env.sim.state, 'running');
  env.advance(1);
  assert.ok(env.sim.clock.now() - clockAtPause <= 1000 + 250, 'resumes from the paused time');
  assert.ok(env.sim.engine.getSnapshot('main').updatesReceived > frozen.updatesReceived);
  assert.deepEqual(env.events.status, ['running', 'paused', 'running']);
  env.sim.reset();
});

test('reset discards all simulated state and leaves live state untouched', () => {
  const env = setup();
  env.postLive(liveTraffic());
  assert.equal(liveFingerprint(env.live), liveFingerprint(env.control));

  env.sim.start();
  env.sim.setScenario('main', 'police-east');
  env.sim.setTour('second', true);
  env.advance(20);
  assert.ok(env.sim.engine.getSnapshot('main').updatesReceived > 0);

  const status = env.sim.reset();
  assert.equal(status.state, 'stopped');
  assert.equal(env.sim.timer, null);
  assert.equal(env.sim.stateService.getAllTrafficStates().length, 0);
  for (const snap of env.sim.engine.getAllSnapshots()) {
    assert.equal(snap.updatesReceived, 0);
    assert.equal(snap.aiStatus, 'WAITING');
    assert.equal(snap.emergency.active, false);
  }
  assert.equal(status.intersections.main.scenario, 'normal');
  assert.equal(status.intersections.main.emergency, null);
  assert.equal(status.intersections.second.tour, false);
  assert.equal(env.events.reset.length, 1);
  assert.equal(env.events.reset[0].length, 2);

  // Live behaved exactly like a twin that never had a simulation beside it.
  assert.equal(liveFingerprint(env.live), liveFingerprint(env.control), 'simulation had no influence on live state');

  // A fresh run starts from zero.
  env.sim.start();
  env.advance(2);
  assert.ok(env.sim.engine.getSnapshot('main').updatesReceived >= 2);
  env.sim.reset();
});

test('a simulator failure stops only the simulation; start() recovers', (t) => {
  const env = setup();
  t.mock.method(console, 'error', () => {});
  env.postLive(liveTraffic());
  env.sim.start();
  const ingest = env.sim.engine.ingest;
  env.sim.engine.ingest = () => { throw new Error('boom'); };
  env.advance(2);
  assert.equal(env.sim.state, 'error');
  assert.equal(env.sim.getStatus().error, 'boom');
  assert.equal(env.sim.timer, null);

  // Live is unaffected and keeps working.
  env.postLive(liveTraffic());
  assert.equal(env.live.getSnapshot('main').updatesReceived, 2);

  env.sim.engine.ingest = ingest;
  env.sim.start();
  assert.equal(env.sim.state, 'running');
  assert.equal(env.events.reset.length, 1, 'recovering from an error starts from a clean state');
  env.advance(2);
  assert.ok(env.sim.engine.getSnapshot('main').updatesReceived >= 2);
  env.sim.reset();
});

test('scenario and tour controls validate their input', () => {
  const { sim } = setup();
  assert.equal(sim.setScenario('nowhere', 'normal').status, 404);
  assert.equal(sim.setScenario('main', 'meteor').status, 400);
  const ok = sim.setScenario('main', 'heavy-east');
  assert.equal(ok.ok, true);
  assert.equal(ok.status.intersections.main.scenario, 'heavy-east');
  assert.equal(sim.setTour('nowhere', true).status, 404);
  assert.equal(sim.setTour('main', true).status.intersections.main.tour, true);
  assert.equal(sim.getStatus().state, 'stopped', 'controls never start the simulation by themselves');
});

test('pausable clock only advances while running', () => {
  let t = 1000;
  const clock = createPausableClock(() => t);
  t += 500;
  assert.equal(clock.now(), 1000, 'starts paused');
  clock.resume();
  t += 200;
  assert.equal(clock.now(), 1200);
  clock.pause();
  t += 10_000;
  assert.equal(clock.now(), 1200);
  clock.resume();
  t += 50;
  assert.equal(clock.now(), 1250);
});
