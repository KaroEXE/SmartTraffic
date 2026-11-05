const EventEmitter = require('events');
const defaultConfig = require('../config');
const { DIRECTIONS, validateObservation, toDecisionInput } = require('../utils/validation');
const { createTrafficDecisionService } = require('./trafficDecisionService');
const { createTrafficStateService } = require('./trafficStateService');
const { buildTopology, OPPOSITE } = require('./networkTopology');
const { createNetworkTrafficModel, straightPath, routePath } = require('./networkTrafficModel');
const { createNetworkCoordinator } = require('./networkCoordinator');

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
 * Each running second, the network traffic model (services/networkTrafficModel.js)
 * advances: new vehicles enter, green approaches release vehicles onto the
 * road to the next intersection (limited by its capacity), and every
 * intersection gets one generated observation. It goes through the same
 * path as a real one: validateObservation -> store -> engine.ingest.
 * Observations are tagged source "simulation". The network coordinator
 * (services/networkCoordinator.js) runs every DECISION_INTERVAL simulated
 * seconds, and simulated emergency vehicles (dispatchAmbulance) report their
 * position to its corridor planner like a GPS feed would.
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

// Vehicles entering an approach fed by another managed intersection mostly
// come from that intersection; local side-street demand is this share of the
// scenario rate.
const INTERNAL_DEMAND_FACTOR = 0.35;

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

function createWorld(id, random, now, model) {
  const world = {
    id,
    random,
    scenario: 'normal',
    scenarioStartedAt: now,
    tour: false,
    tourIndex: 0,
    drift: {},
    bias: {},
    pedestrians: {},
    emergency: null,
    nextRandomPedAt: 0,
  };
  for (const d of DIRECTIONS) {
    world.drift[d] = rand(world, 0, Math.PI * 2);
    world.bias[d] = rand(world, 0.75, 1.3);
    world.pedestrians[d] = false;
    // A little traffic so the first frame is not empty.
    const n = Math.round(rand(world, 1, 5));
    const arrivals = [];
    for (let i = 0; i < n; i += 1) arrivals.push(now - rand(world, 0, 15000));
    model.setQueue(id, d, arrivals.sort((a, b) => a - b));
  }
  world.nextRandomPedAt = now + rand(world, 25, 70) * 1000;
  return world;
}

function applyScenario(world, scenarioId, now, model, { fromTour = false } = {}) {
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
    model.setQueue(world.id, 'west', [now - 38000, now - 34000, now - 29000, now - 21000]);
  }
  return true;
}

function advanceTour(world, now, model) {
  if (!world.tour) return;
  const [id, duration] = TOUR[world.tourIndex];
  const elapsed = (now - world.scenarioStartedAt) / 1000;
  const done = duration === null ? !world.emergency || elapsed > 75 : elapsed >= duration;
  if (!done) return;
  if (duration === null && world.emergency) world.emergency = null;
  world.tourIndex = (world.tourIndex + 1) % TOUR.length;
  applyScenario(world, TOUR[world.tourIndex][0], now, model, { fromTour: true });
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

/** New vehicles entering the network at one intersection this second. */
function generateArrivals(world, now, model) {
  advanceTour(world, now, model);
  for (const dir of DIRECTIONS) {
    const rate = rateFor(world, dir, now) * (model.isBoundary(world.id, dir) ? 1 : INTERNAL_DEMAND_FACTOR);
    model.arrive(world.id, dir, poisson(world, rate), now, MAX_QUEUE);
  }
}

/** What the intersection's cameras report this second, given its signal state. */
function observeWorld(world, snap, now, model) {
  const signals = snap ? snap.signals : {};
  const walking = snap ? snap.pedestrianSignals : {};
  // Vehicles coming from outside the managed network that are already in view.
  const traffic = model.observation(world.id, now, (dir) => poisson(world, rateFor(world, dir, now) * 6));

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
  // A dispatched emergency vehicle close to this intersection is seen by its camera.
  const seen = !emergency.detected && model.cameraSees(world.id);
  if (seen) emergency = { detected: true, type: seen.type, direction: seen.direction, confidence: 0.93 };

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
    this.config = config;
    this.topology = buildTopology(intersections, config.network || {});
    // The coordinator runs inside the generator tick (every DECISION_INTERVAL
    // simulated seconds), so it pauses and resumes with the simulation.
    this.coordinator = createNetworkCoordinator({
      engine: this.engine,
      topology: this.topology,
      config,
      now: this.clock.now,
      dataMode: 'simulation',
      enabled: !config.network || config.network.ENABLED !== false,
      cameraCorridors: true,
    });
    this.decisionEvery = Math.max(1, Math.round((config.network && config.network.DECISION_INTERVAL) || 2));
    this.state = 'stopped';
    this.lastError = null;
    this.timer = null;
    this.worlds = new Map();
    this.lastAmbulance = null;
    this._createWorlds();
  }

  _createWorlds() {
    const now = this.clock.now();
    this.model = createNetworkTrafficModel({
      topology: this.topology, ids: this.intersections.map((i) => i.id), random: this.random,
    });
    this.worlds = new Map(this.intersections.map((ix) => [ix.id, createWorld(ix.id, this.random, now, this.model)]));
    this.coordinator.reset();
    this.ticks = 0;
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
    this.lastAmbulance = null;
    this.lastError = null;
    this.state = 'stopped';
    this.emit('reset', this.engine.getAllSnapshots());
  }

  setScenario(intersectionId, scenarioId) {
    const world = this.worlds.get(intersectionId);
    if (!world) return { ok: false, status: 404, error: `Unknown intersectionId "${intersectionId}"` };
    if (!applyScenario(world, scenarioId, this.clock.now(), this.model)) {
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
      applyScenario(world, TOUR[0][0], this.clock.now(), this.model, { fromTour: true });
    }
    this.emit('status', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  /** Network-wide optimisation on (coordinated) or off (every intersection alone). */
  setNetworkOptimization(enabled) {
    this.coordinator.setEnabled(enabled);
    this.emit('status', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  /**
   * Sends a SIMULATED emergency vehicle through the network. It starts
   * 150 m before `from` and either drives straight on (`heading` = travel
   * direction) or follows `route` (adjacent intersection ids starting with
   * `from`). Its position is reported to the corridor planner every second,
   * as a GPS feed would.
   */
  dispatchAmbulance({
    from, heading, route, type = 'ambulance',
  } = {}) {
    if (typeof from !== 'string' || !this.topology.has(from)) {
      return { ok: false, status: 404, error: `Unknown intersectionId "${from}"` };
    }
    if (!['ambulance', 'police', 'fire_truck'].includes(type)) return { ok: false, status: 400, error: 'type must be ambulance, police or fire_truck' };
    let path;
    if (route !== undefined) {
      if (!Array.isArray(route) || route.length < 1 || route[0] !== from || route.some((id) => !this.topology.has(id))) {
        return { ok: false, status: 400, error: 'route must be a list of intersection ids starting with "from"' };
      }
      const firstHeading = heading || (route.length > 1 ? this.topology.headingBetween(route[0], route[1]) : null);
      if (!DIRECTIONS.includes(firstHeading)) return { ok: false, status: 400, error: 'heading is required for a one-intersection route' };
      path = routePath(this.topology, route, OPPOSITE[firstHeading]);
      if (!path) return { ok: false, status: 400, error: 'every route step must be a road between neighbouring intersections' };
    } else {
      if (!DIRECTIONS.includes(heading)) return { ok: false, status: 400, error: `heading must be one of ${DIRECTIONS.join(', ')}` };
      path = straightPath(this.topology, from, heading);
    }
    const id = this.model.dispatch({ type, path, t: this.clock.now() });
    this._reportTracks();
    this.emit('status', this.getStatus());
    return { ok: true, vehicleId: id, status: this.getStatus() };
  }

  /** New route from the vehicle's next intersection onward (route change). */
  rerouteAmbulance(vehicleId, route) {
    const a = this.model.ambulance(vehicleId);
    if (!a || a.finishedAt !== null) return { ok: false, status: 404, error: `No active emergency vehicle "${vehicleId}"` };
    const at = a.path[a.index];
    if (!Array.isArray(route) || route[0] !== at.id) {
      return { ok: false, status: 400, error: `route must start with the vehicle's next intersection "${at.id}"` };
    }
    const path = routePath(this.topology, route, at.approach);
    if (!path) return { ok: false, status: 400, error: 'every route step must be a road between neighbouring intersections' };
    this.model.reroute(vehicleId, path);
    this._reportTracks();
    this.emit('status', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  cancelAmbulance(vehicleId) {
    if (!this.model.cancel(vehicleId)) return { ok: false, status: 404, error: `No emergency vehicle "${vehicleId}"` };
    this.coordinator.planner.removeTrack(vehicleId);
    this.emit('status', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  getStatus() {
    return {
      dataMode: 'simulation',
      state: this.state,
      error: this.lastError,
      scenarios: SCENARIOS.map(({ id, label }) => ({ id, label })),
      network: { enabled: this.coordinator.enabled },
      ambulances: this.model.ambulances().filter((a) => a.finishedAt === null).map((a) => ({
        id: a.id,
        type: a.type,
        route: a.path.map((p) => p.id),
        towards: a.path[a.index] ? a.path[a.index].id : null,
        distanceM: Math.round(a.distanceM),
        stops: a.stops,
        stoppedSeconds: a.stoppedSeconds,
        waiting: a.moving ? null : a.waitReason || null,
      })),
      lastAmbulance: this.lastAmbulance,
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

  _reportTracks() {
    for (const track of this.model.tracks()) this.coordinator.planner.updateTrack(track);
  }

  /** One simulated second for the whole network. Ignored unless running. */
  tick() {
    if (this.state !== 'running') return;
    try {
      const now = this.clock.now();
      const signalsOf = (id) => this.engine.getSnapshot(id).signals;
      for (const world of this.worlds.values()) generateArrivals(world, now, this.model);
      this.model.step(now, signalsOf);

      const events = this.model.stepAmbulances(now, signalsOf);
      for (const e of events.filter((ev) => ev.type === 'finished')) {
        const a = this.model.ambulance(e.vehicleId);
        this.lastAmbulance = {
          id: a.id,
          type: a.type,
          route: a.path.map((p) => p.id),
          stops: a.stops,
          stoppedSeconds: a.stoppedSeconds,
          travelSeconds: Math.round((a.finishedAt - a.startedAt) / 1000),
          delaySeconds: Math.max(0, Math.round((a.finishedAt - a.startedAt) / 1000 - a.freeFlowSeconds)),
        };
        this.model.cancel(e.vehicleId);
        this.coordinator.planner.removeTrack(e.vehicleId);
      }
      this._reportTracks();

      for (const world of this.worlds.values()) {
        const observation = observeWorld(world, this.engine.getSnapshot(world.id), now, this.model);
        observation.timestamp = new Date(this.real()).toISOString();
        this._submit(observation);
      }
      this.ticks += 1;
      if (this.ticks % this.decisionEvery === 0) this.coordinator.cycle();
      if (events.length) this.emit('status', this.getStatus());
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

module.exports = {
  SimulationService,
  createSimulationService,
  SCENARIOS,
  SCENARIO_BY_ID,
  createPausableClock,
  INTERNAL_DEMAND_FACTOR,
  // Demand model, shared with the controlled benchmark (simulationBenchmark.js).
  poisson,
  rateFor,
};
