const EventEmitter = require('events');
const defaultConfig = require('../config');
const { DIRECTIONS, validateObservation, toDecisionInput } = require('../utils/validation');
const { createTrafficDecisionService } = require('./trafficDecisionService');
const { createTrafficStateService } = require('./trafficStateService');

/**
 * Simulation - generated traffic for demonstrations, completely separate from
 * live traffic.
 *
 * It owns its own decision engine (dataMode "simulation") and its own
 * observation store. It shares no object with the live engine, never calls
 * into it, and has no HTTP ingestion endpoint, so simulated observations
 * cannot reach live state or trigger live signal decisions or emergency
 * preemption. Live traffic does not depend on this module: it creates no
 * timers until start() is called, and a failure here only sets
 * state = "error".
 *
 *   state: stopped  -> start() -> running -> pause() -> paused -> start() -> running
 *          any      -> reset() -> stopped (fresh engine state, scenarios back to "normal")
 *          running  -> generator failure -> error (live is unaffected; start() resets and retries)
 *
 * Each running second, every intersection gets one generated observation. It
 * goes through the same path as a real one: validateObservation -> store ->
 * engine.ingest. Observations are tagged source "simulation".
 *
 * Events: 'status' (control state changed), 'reset' (all state discarded).
 * The engine's own events (trafficUpdate / signalUpdate / systemEvent) are
 * emitted by `simulation.engine`.
 */

const GENERATOR_TICK_MS = 1000;
const ENGINE_TICK_MS = 250;
const MAX_QUEUE = 45;
const SOURCE = 'simulation';

// ---------------------------------------------------------------- scenarios

const NORMAL_RATES = { north: 0.16, south: 0.13, east: 0.15, west: 0.11 };

const SCENARIOS = [
  { id: 'normal', label: 'Normal traffic', rates: NORMAL_RATES, drift: true },
  { id: 'heavy-east', label: 'Heavy East', rates: { north: 0.09, south: 0.08, east: 0.55, west: 0.07 } },
  { id: 'heavy-north', label: 'Heavy North', rates: { north: 0.55, south: 0.09, east: 0.08, west: 0.07 } },
  { id: 'long-wait-west', label: 'Long wait West', rates: { north: 0.3, south: 0.28, east: 0.05, west: 0.03 } },
  { id: 'pedestrian-south', label: 'Pedestrians South', rates: NORMAL_RATES, pedestrian: 'south' },
  { id: 'ambulance-north', label: 'Ambulance North', rates: NORMAL_RATES, emergency: { type: 'ambulance', direction: 'north' } },
  { id: 'police-east', label: 'Police East', rates: NORMAL_RATES, emergency: { type: 'police', direction: 'east' } },
  { id: 'emergency-cleared', label: 'Emergency cleared', rates: NORMAL_RATES, clearEmergency: true },
];
const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

// Scripted loop for "Auto tour". `null` duration = until the emergency vehicle has passed (capped at 75 s).
const TOUR = [
  ['normal', 30],
  ['heavy-east', 40],
  ['pedestrian-south', 30],
  ['ambulance-north', null],
  ['normal', 20],
  ['heavy-north', 35],
  ['long-wait-west', 50],
  ['police-east', null],
];

// The simulated emergency vehicle is reported until its approach has been green this long.
const EMERGENCY_PASS_SECONDS = 15;

// ---------------------------------------------------------------- generator

function poisson(world, lambda) {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= world.random();
  } while (p > limit);
  return k - 1;
}

const rand = (world, min, max) => min + world.random() * (max - min);

function createWorld(id, random, now) {
  const world = {
    id,
    random,
    scenario: 'normal',
    scenarioStartedAt: now,
    tour: false,
    tourIndex: 0,
    drift: {},
    bias: {},
    queues: {},
    pedestrians: {},
    emergency: null,
    nextRandomPedAt: 0,
  };
  for (const d of DIRECTIONS) {
    world.drift[d] = rand(world, 0, Math.PI * 2);
    world.bias[d] = rand(world, 0.75, 1.3);
    world.pedestrians[d] = false;
    world.queues[d] = [];
    // A little traffic so the first frame is not empty.
    const n = Math.round(rand(world, 1, 5));
    for (let i = 0; i < n; i += 1) world.queues[d].push(now - rand(world, 0, 15000));
  }
  world.nextRandomPedAt = now + rand(world, 25, 70) * 1000;
  return world;
}

function applyScenario(world, scenarioId, now, { fromTour = false } = {}) {
  const scenario = SCENARIO_BY_ID[scenarioId];
  if (!scenario) return false;
  if (!fromTour) world.tour = false;

  world.scenario = scenario.clearEmergency ? 'normal' : scenario.id;
  world.scenarioStartedAt = now;

  if (scenario.emergency) world.emergency = { ...scenario.emergency, ticks: 0, greenFor: 0 };
  if (scenario.clearEmergency) world.emergency = null;
  if (scenario.pedestrian) world.pedestrians[scenario.pedestrian] = true;
  if (scenario.id === 'long-wait-west') {
    // A few vehicles that have already been waiting a while.
    world.queues.west = [now - 38000, now - 34000, now - 29000, now - 21000];
  }
  return true;
}

function advanceTour(world, now) {
  if (!world.tour) return;
  const [id, duration] = TOUR[world.tourIndex];
  const elapsed = (now - world.scenarioStartedAt) / 1000;
  const done = duration === null ? !world.emergency || elapsed > 75 : elapsed >= duration;
  if (!done) return;
  if (duration === null && world.emergency) world.emergency = null;
  world.tourIndex = (world.tourIndex + 1) % TOUR.length;
  applyScenario(world, TOUR[world.tourIndex][0], now, { fromTour: true });
  if (id === 'pedestrian-south') world.pedestrians.south = false;
}

function rateFor(world, dir, now) {
  const scenario = SCENARIO_BY_ID[world.scenario] || SCENARIO_BY_ID.normal;
  let rate = scenario.rates[dir];
  if (scenario.drift) {
    // Slow, per-approach variation so normal traffic is never static.
    rate *= world.bias[dir] * (1 + 0.45 * Math.sin(now / 45000 + world.drift[dir]));
  }
  return Math.max(0.01, rate);
}

/** One simulated second at one intersection, given its current signal state. Returns an observation. */
function stepWorld(world, snap, now) {
  const signals = snap ? snap.signals : {};
  const walking = snap ? snap.pedestrianSignals : {};

  advanceTour(world, now);

  const traffic = {};
  for (const dir of DIRECTIONS) {
    const queue = world.queues[dir];
    const rate = rateFor(world, dir, now);

    const arrivals = poisson(world, rate);
    for (let i = 0; i < arrivals && queue.length < MAX_QUEUE; i += 1) queue.push(now);

    if (signals[dir] === 'GREEN') {
      queue.splice(0, 1 + (world.random() < 0.35 ? 1 : 0));
    } else if (signals[dir] === 'YELLOW' && world.random() < 0.5) {
      queue.shift();
    }

    const waiting = queue.length ? queue.reduce((sum, t) => sum + (now - t), 0) / queue.length / 1000 : 0;
    // Vehicles in view = queued + moving vehicles approaching the stop line.
    traffic[dir] = {
      vehicles: queue.length + poisson(world, rate * 6),
      queueLength: queue.length,
      waitingTime: Math.round(waiting * 10) / 10,
    };
  }

  // A pedestrian request stays up until the engine has let them walk.
  for (const dir of DIRECTIONS) {
    if (world.pedestrians[dir] && walking[dir] === 'WALK') world.pedestrians[dir] = false;
  }
  if (now >= world.nextRandomPedAt) {
    world.pedestrians[DIRECTIONS[Math.floor(world.random() * 4)]] = true;
    world.nextRandomPedAt = now + rand(world, 60, 140) * 1000;
  }

  // Detection confidence firms up as the vehicle approaches, then it is
  // reported until it has passed on green.
  let emergency = { detected: false, type: null, direction: null, confidence: 0 };
  if (world.emergency) {
    const em = world.emergency;
    const confidence = em.ticks === 0 ? 0.72 : em.ticks === 1 ? 0.86 : rand(world, 0.91, 0.97);
    em.ticks += 1;
    if (signals[em.direction] === 'GREEN') em.greenFor += 1;
    if (em.greenFor >= EMERGENCY_PASS_SECONDS) {
      world.emergency = null;
      if (!world.tour) world.scenario = 'normal';
    } else {
      emergency = {
        detected: true,
        type: em.type,
        direction: em.direction,
        confidence: Math.round(confidence * 100) / 100,
      };
    }
  }

  return {
    intersectionId: world.id,
    source: SOURCE,
    timestamp: null, // filled with wall-clock time by the service
    traffic,
    pedestrians: { ...world.pedestrians },
    emergency,
  };
}

// -------------------------------------------------------------------- clock

/** Clock that stops while paused, so a paused simulation resumes where it left off. */
function createPausableClock(real = Date.now) {
  let offset = 0;
  let pausedAt = real(); // starts frozen: no time passes before the first start()
  return {
    now: () => (pausedAt === null ? real() : pausedAt) - offset,
    pause() { if (pausedAt === null) pausedAt = real(); },
    resume() {
      if (pausedAt !== null) {
        offset += real() - pausedAt;
        pausedAt = null;
      }
    },
  };
}

// ------------------------------------------------------------------ service

class SimulationService extends EventEmitter {
  constructor({
    intersections,
    config = defaultConfig,
    real = Date.now,
    random = Math.random,
    generatorTickMs = GENERATOR_TICK_MS,
    engineTickMs = ENGINE_TICK_MS,
  }) {
    super();
    this.real = real;
    this.random = random;
    this.generatorTickMs = generatorTickMs;
    this.engineTickMs = engineTickMs;
    this.clock = createPausableClock(real);
    this.engine = createTrafficDecisionService({
      intersections, config, now: this.clock.now, dataMode: 'simulation',
    });
    this.stateService = createTrafficStateService({ now: real });
    this.intersections = intersections;
    this.state = 'stopped';
    this.lastError = null;
    this.timer = null;
    this.worlds = new Map();
    this._createWorlds();
  }

  _createWorlds() {
    this.worlds = new Map(this.intersections.map((ix) => [ix.id, createWorld(ix.id, this.random, this.clock.now())]));
  }

  // ----------------------------------------------------------------- control

  start() {
    if (this.state === 'running') return this.getStatus();
    if (this.state === 'error') this._discardState();
    this.clock.resume();
    this.engine.start(this.engineTickMs);
    this.timer = setInterval(() => this.tick(), this.generatorTickMs);
    this.timer.unref();
    this._setState('running');
    this.tick(); // first observations immediately
    return this.getStatus();
  }

  pause() {
    if (this.state !== 'running') return this.getStatus();
    this._stopTimers();
    this.clock.pause();
    this._setState('paused');
    return this.getStatus();
  }

  /** Stops, discards all simulated state and returns to the initial condition. Live state is not touched. */
  reset() {
    this._discardState();
    this._setState('stopped');
    return this.getStatus();
  }

  _discardState() {
    this._stopTimers();
    this.clock.pause();
    this.engine.reset();
    this.stateService.clear();
    this._createWorlds();
    this.lastError = null;
    this.state = 'stopped';
    this.emit('reset', this.engine.getAllSnapshots());
  }

  setScenario(intersectionId, scenarioId) {
    const world = this.worlds.get(intersectionId);
    if (!world) return { ok: false, status: 404, error: `Unknown intersectionId "${intersectionId}"` };
    if (!applyScenario(world, scenarioId, this.clock.now())) {
      return { ok: false, status: 400, error: `Unknown scenario. Use one of: ${SCENARIOS.map((s) => s.id).join(', ')}` };
    }
    this.emit('status', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  setTour(intersectionId, enabled) {
    const world = this.worlds.get(intersectionId);
    if (!world) return { ok: false, status: 404, error: `Unknown intersectionId "${intersectionId}"` };
    world.tour = Boolean(enabled);
    if (world.tour) {
      world.tourIndex = 0;
      applyScenario(world, TOUR[0][0], this.clock.now(), { fromTour: true });
    }
    this.emit('status', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  getStatus() {
    return {
      dataMode: 'simulation',
      state: this.state,
      error: this.lastError,
      scenarios: SCENARIOS.map(({ id, label }) => ({ id, label })),
      intersections: Object.fromEntries([...this.worlds.values()].map((w) => [w.id, {
        scenario: w.scenario,
        tour: w.tour,
        emergency: w.emergency ? { type: w.emergency.type, direction: w.emergency.direction } : null,
        pedestrians: { ...w.pedestrians },
      }])),
    };
  }

  // ---------------------------------------------------------------- internal

  _setState(state) {
    this.state = state;
    this.emit('status', this.getStatus());
  }

  _stopTimers() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine.stop();
  }

  /** Generates and submits one observation per intersection. Ignored unless running. */
  tick() {
    if (this.state !== 'running') return;
    try {
      const now = this.clock.now();
      for (const world of this.worlds.values()) {
        const observation = stepWorld(world, this.engine.getSnapshot(world.id), now);
        observation.timestamp = new Date(this.real()).toISOString();
        this._submit(observation);
      }
    } catch (err) {
      this._fail(err);
    }
  }

  /** Same path as a real observation: validate -> store -> engine. Never reaches the live objects. */
  _submit(payload) {
    const result = validateObservation(payload);
    if (!result.ok) throw new Error(`simulator produced an invalid observation: ${result.errors.join('; ')}`);
    const stored = this.stateService.setTrafficState(result.value);
    if (stored.stored) this.engine.ingest(toDecisionInput(result.value));
  }

  _fail(err) {
    this._stopTimers();
    this.clock.pause();
    this.lastError = String((err && err.message) || err);
    console.error(`[simulation] stopped after an error (live traffic is not affected): ${this.lastError}`);
    this._setState('error');
  }
}

function createSimulationService(options) {
  return new SimulationService(options);
}

module.exports = { SimulationService, createSimulationService, SCENARIOS, createPausableClock };
