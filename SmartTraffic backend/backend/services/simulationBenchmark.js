const { createTrafficDecisionService } = require('./trafficDecisionService');
const {
  SCENARIO_BY_ID, poisson, rateFor, INTERNAL_DEMAND_FACTOR,
} = require('./simulationService');
const { buildTopology } = require('./networkTopology');
const { createNetworkTrafficModel, straightPath } = require('./networkTrafficModel');
const { createNetworkCoordinator } = require('./networkCoordinator');
const { DIRECTIONS } = require('../utils/validation');

/**
 * Controlled benchmark on the SIMULATED road network: three control
 * policies, the same traffic demand, measured the same way. Simulation only
 * - nothing here is a real-world measurement, and every result carries
 * dataMode "simulation".
 *
 *   fixed    the decision engine without observations: its fixed-time plan
 *            (what runs in production when the cameras are down)
 *   local    the decision engine fed one observation per intersection per
 *            second - every intersection decides from its own data
 *   network  the same, plus the network coordinator: network-aware scores,
 *            spillback guard and the emergency corridor
 *
 * All three use the backend's own engine and safety timing, and the network
 * traffic model (services/networkTrafficModel.js) with deterministic
 * discharge: vehicles released at one intersection drive to the next, and a
 * full road blocks release (spillback).
 *
 * Demand: vehicles entering the network, drawn ONCE from a seeded generator
 * with the Simulation tab's demand model (scenario rates with slow drift;
 * approaches fed by another managed intersection get INTERNAL_DEMAND_FACTOR
 * of it as side-street traffic) and replayed identically to every policy.
 * Profile 'surge' doubles demand from 20% to 50% of the run to measure how
 * long congestion takes to clear. Optionally one emergency vehicle drives the
 * longest straight route through the network.
 */

const ENGINE_TICKS_PER_SECOND = 4;
const LOOKAHEAD_SECONDS = 6;
const POLICIES = ['fixed', 'local', 'network'];

const LIMITS = {
  durationSeconds: [120, 1800], // runs in a worker thread
  warmupSeconds: [0, 600],
  sampleEverySeconds: [5, 120],
};

/** Small deterministic PRNG (mulberry32), seeded: results must be repeatable. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/**
 * Improvement in percent, from two measured values.
 *   lower is better:  (baseline - optimized) / baseline x 100
 *   higher is better: (optimized - baseline) / baseline x 100
 * null when it cannot be computed (missing value or zero baseline).
 */
function improvementPercent(baseline, optimized, { higherIsBetter = false } = {}) {
  if (!Number.isFinite(baseline) || !Number.isFinite(optimized) || baseline === 0) return null;
  const change = higherIsBetter ? optimized - baseline : baseline - optimized;
  return round((change / baseline) * 100, 1);
}

// metric -> higher is better
const METRICS = {
  averageWaitSeconds: false,
  maxWaitSeconds: false,
  totalWaitVehicleHours: false,
  averageQueue: false,
  maxQueue: false,
  throughputVehicles: true,
  spillbackSeconds: false,
  spillbackIncidents: false,
  clearSeconds: false,
  emergencyStops: false,
  emergencyDelaySeconds: false,
};

function validateOptions(options, intersections) {
  const errors = [];
  const scenario = options.scenario === undefined ? 'normal' : options.scenario;
  const s = SCENARIO_BY_ID[scenario];
  if (typeof scenario !== 'string' || !s || s.emergency || s.pedestrian || s.clearEmergency) {
    errors.push('scenario must be one of normal, heavy-east, heavy-north, long-wait-west');
  }
  const int = (name, fallback) => {
    const v = options[name] === undefined ? fallback : options[name];
    const [min, max] = LIMITS[name];
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  const durationSeconds = int('durationSeconds', 900);
  const warmupSeconds = int('warmupSeconds', 60);
  const sampleEverySeconds = int('sampleEverySeconds', 15);
  if (Number.isInteger(durationSeconds) && Number.isInteger(warmupSeconds) && warmupSeconds >= durationSeconds - 60) {
    errors.push('warmupSeconds must leave at least 60 s of measurement');
  }
  const seed = options.seed === undefined ? 1 : options.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2 ** 31) errors.push('seed must be a non-negative integer');
  const profile = options.profile === undefined ? 'steady' : options.profile;
  if (!['steady', 'surge'].includes(profile)) errors.push('profile must be steady or surge');
  const ambulance = options.ambulance === undefined ? false : options.ambulance;
  if (typeof ambulance !== 'boolean') errors.push('ambulance must be true or false');
  let ids = intersections.map((i) => i.id);
  if (options.intersectionIds !== undefined) {
    if (!Array.isArray(options.intersectionIds) || !options.intersectionIds.length
      || options.intersectionIds.some((id) => !ids.includes(id))) {
      errors.push(`intersectionIds must be a non-empty list of: ${ids.join(', ')}`);
    } else ids = [...new Set(options.intersectionIds)];
  }
  return {
    errors,
    value: {
      scenario, durationSeconds, warmupSeconds, sampleEverySeconds, seed, profile, ambulance, intersectionIds: ids,
    },
  };
}

function surgeWindow({ profile, durationSeconds }) {
  if (profile !== 'surge') return null;
  return { start: Math.round(durationSeconds * 0.2), end: Math.round(durationSeconds * 0.5) };
}

/** Vehicles entering the network per intersection, second and approach - drawn once, replayed to every policy. */
function drawDemand(ids, topology, params) {
  const surge = surgeWindow(params);
  const demand = new Map();
  for (const id of ids) {
    const random = seededRandom(params.seed ^ hash(id));
    const world = { random, scenario: params.scenario, bias: {}, drift: {} };
    for (const d of DIRECTIONS) {
      world.drift[d] = random() * Math.PI * 2;
      world.bias[d] = 0.75 + random() * 0.55;
    }
    const internal = Object.fromEntries(DIRECTIONS.map((d) => {
      const up = topology.upstreamOf(id, d);
      return [d, Boolean(up && ids.includes(up.from))];
    }));
    const perSecond = [];
    for (let t = 0; t < params.durationSeconds + LOOKAHEAD_SECONDS; t += 1) {
      const factor = surge && t >= surge.start && t < surge.end ? 2 : 1;
      const row = {};
      for (const d of DIRECTIONS) {
        row[d] = poisson(world, rateFor(world, d, t * 1000) * factor * (internal[d] ? INTERNAL_DEMAND_FACTOR : 1));
      }
      perSecond.push(row);
    }
    demand.set(id, { perSecond, internal });
  }
  return demand;
}

/** The longest straight route through the network (the emergency vehicle's route). */
function emergencyRoute(topology) {
  let best = null;
  for (const node of topology.nodes) {
    for (const heading of ['east', 'west', 'north', 'south']) {
      const path = straightPath(topology, node.id, heading);
      if (!best || path.length > best.length) best = path;
    }
  }
  return best;
}

function runPolicy(policy, {
  intersections, config, topology, demand, params, route,
}) {
  const { durationSeconds, warmupSeconds, sampleEverySeconds } = params;
  const ids = intersections.map((i) => i.id);
  const T0 = Date.UTC(2026, 0, 1);
  let clockMs = T0;
  const now = () => clockMs;
  const engine = createTrafficDecisionService({
    intersections, config, now, dataMode: 'simulation',
  });
  const coordinator = policy === 'network'
    ? createNetworkCoordinator({
      engine, topology, config, now, dataMode: 'simulation', enabled: true, cameraCorridors: true,
    })
    : null;
  const decisionEvery = Math.max(1, Math.round((config.network && config.network.DECISION_INTERVAL) || 2));
  const model = createNetworkTrafficModel({ topology, ids, random: null });
  const signalsOf = (id) => engine.getSnapshot(id).signals;
  const surge = surgeWindow(params);
  const dispatchAt = route ? warmupSeconds + Math.max(30, Math.round((durationSeconds - warmupSeconds) * 0.25)) : null;

  const m = {
    entered: 0, queueIntegral: 0, samples: 0, maxQueue: 0, maxWait: 0, exited: 0,
    spillbackSeconds: 0, spillbackIncidents: 0, perIx: {},
  };
  for (const id of ids) m.perIx[id] = { queueIntegral: 0, samples: 0, maxQueue: 0, spillbackSeconds: 0 };
  const series = [];
  let surgeStartQueue = null;
  let clearedAt = null;
  let vehicleId = null;

  for (let t = 0; t < durationSeconds; t += 1) {
    const tMs = T0 + t * 1000;
    clockMs = tMs;
    const inWindow = t >= warmupSeconds;
    for (const id of ids) {
      const row = demand.get(id).perSecond[t];
      for (const d of DIRECTIONS) {
        model.arrive(id, d, row[d], tMs);
        if (inWindow) m.entered += row[d];
      }
    }
    if (t === dispatchAt) vehicleId = model.dispatch({ type: 'ambulance', path: route, t: tMs });

    const out = model.step(tMs, signalsOf);
    const events = model.stepAmbulances(tMs, signalsOf);
    if (coordinator) {
      for (const track of model.tracks()) coordinator.planner.updateTrack(track);
      for (const e of events) if (e.type === 'finished') coordinator.planner.removeTrack(e.vehicleId);
    }

    if (inWindow) {
      m.exited += out.exited;
      m.spillbackSeconds += out.spillback.length;
      m.spillbackIncidents += out.spillbackOnsets;
      for (const s of out.spillback) m.perIx[s.intersectionId].spillbackSeconds += 1;
      for (const delay of out.delays) m.maxWait = Math.max(m.maxWait, delay / 1000);
      for (const id of ids) {
        for (const d of DIRECTIONS) {
          const q = model.queue(id, d).length;
          m.queueIntegral += q;
          m.samples += 1;
          m.maxQueue = Math.max(m.maxQueue, q);
          const p = m.perIx[id];
          p.queueIntegral += q;
          p.samples += 1;
          p.maxQueue = Math.max(p.maxQueue, q);
        }
      }
    }

    // Congestion clearing after a demand surge.
    const queued = model.totalQueued();
    if (surge && t === surge.start) surgeStartQueue = queued;
    if (surge && t >= surge.end && clearedAt === null && surgeStartQueue !== null
      && queued <= Math.max(surgeStartQueue * 1.1, surgeStartQueue + 5)) clearedAt = t;

    // Cameras report to the engine (not in the fixed-time policy).
    if (policy !== 'fixed') {
      for (const id of ids) {
        const rows = demand.get(id);
        const traffic = model.observation(id, tMs, (d) => {
          if (rows.internal[d]) return 0;
          let n = 0;
          for (let k = 1; k <= LOOKAHEAD_SECONDS; k += 1) n += rows.perSecond[t + k][d];
          return n;
        });
        const seen = model.cameraSees(id);
        engine.ingest({
          intersectionId: id,
          timestamp: new Date(tMs).toISOString(),
          source: 'simulation',
          traffic: Object.fromEntries(DIRECTIONS.map((d) => [d, {
            vehicles: traffic[d].vehicles, queueLength: traffic[d].queueLength, waiting: traffic[d].waitingTime,
          }])),
          pedestrians: { north: false, south: false, east: false, west: false },
          detectors: { pedestrians: false, emergency: true },
          emergency: seen
            ? { detected: true, type: seen.type, direction: seen.direction, confidence: 0.93 }
            : { detected: false, type: null, direction: null, confidence: 0 },
        });
      }
    }
    if (coordinator && t % decisionEvery === 0) coordinator.cycle();

    if (inWindow && (t - warmupSeconds) % sampleEverySeconds === 0) {
      let waitSum = 0;
      for (const id of ids) for (const d of DIRECTIONS) for (const a of model.queue(id, d)) waitSum += tMs - a;
      series.push({
        t: t - warmupSeconds,
        queued,
        averageQueuedWaitSeconds: queued ? round(waitSum / queued / 1000) : 0,
        exitedCumulative: m.exited,
        spillbackSecondsCumulative: m.spillbackSeconds,
      });
    }

    for (let k = 0; k < ENGINE_TICKS_PER_SECOND; k += 1) {
      clockMs += 1000 / ENGINE_TICKS_PER_SECOND;
      engine.tick();
    }
  }

  const endMs = T0 + durationSeconds * 1000;
  for (const id of ids) for (const d of DIRECTIONS) for (const a of model.queue(id, d)) m.maxWait = Math.max(m.maxWait, (endMs - a) / 1000);
  const measured = durationSeconds - warmupSeconds;
  const amb = vehicleId ? model.ambulance(vehicleId) : null;
  const emergency = amb
    ? {
      route: amb.path.map((p) => p.id),
      finished: amb.finishedAt !== null,
      stops: amb.stops,
      stoppedSeconds: amb.stoppedSeconds,
      travelSeconds: amb.finishedAt !== null ? round((amb.finishedAt - amb.startedAt) / 1000) : null,
      freeFlowSeconds: round(amb.freeFlowSeconds),
      delaySeconds: amb.finishedAt !== null ? round(Math.max(0, (amb.finishedAt - amb.startedAt) / 1000 - amb.freeFlowSeconds)) : null,
    }
    : null;
  const network = {
    averageWaitSeconds: m.entered ? round(m.queueIntegral / m.entered) : null,
    maxWaitSeconds: round(m.maxWait),
    totalWaitVehicleHours: round(m.queueIntegral / 3600, 2),
    averageQueue: m.samples ? round(m.queueIntegral / m.samples, 2) : null,
    maxQueue: m.maxQueue,
    throughputVehicles: m.exited,
    throughputPerHour: round((m.exited / measured) * 3600, 0),
    spillbackSeconds: m.spillbackSeconds,
    spillbackIncidents: m.spillbackIncidents,
    clearSeconds: surge && clearedAt !== null ? clearedAt - surge.end : null,
    clearedWithinRun: surge ? clearedAt !== null : null,
    stillQueued: model.totalQueued(),
    vehiclesEntered: m.entered,
    emergencyStops: emergency ? emergency.stops : null,
    emergencyDelaySeconds: emergency ? emergency.delaySeconds : null,
  };
  const perIntersection = Object.fromEntries(ids.map((id) => {
    const p = m.perIx[id];
    return [id, {
      averageQueue: p.samples ? round(p.queueIntegral / p.samples, 2) : null,
      maxQueue: p.maxQueue,
      totalWaitVehicleHours: round(p.queueIntegral / 3600, 2),
      spillbackSeconds: p.spillbackSeconds,
    }];
  }));
  return {
    policy,
    controllerModes: [...new Set(ids.map((id) => engine.getSnapshot(id).mode))],
    network,
    perIntersection,
    emergency,
    decisionsMade: coordinator ? coordinator.cycleNo : 0,
    series,
  };
}

function compare(base, opt) {
  return Object.fromEntries(Object.entries(METRICS).map(([k, higher]) => [k, improvementPercent(base[k], opt[k], { higherIsBetter: higher })]));
}

/**
 * Runs every policy on identical demand. Returns { ok, result } or
 * { ok: false, errors }.
 */
function runBenchmark({ intersections, config, now = Date.now, ...options }) {
  const { errors, value: params } = validateOptions(options, intersections);
  if (errors.length) return { ok: false, errors };
  const chosen = intersections.filter((i) => params.intersectionIds.includes(i.id));
  const topology = buildTopology(chosen, config.network || {});
  const demand = drawDemand(params.intersectionIds, topology, params);
  const route = params.ambulance ? emergencyRoute(topology) : null;

  const started = now();
  const runs = Object.fromEntries(POLICIES.map((p) => [p, runPolicy(p, {
    intersections: chosen, config, topology, demand, params, route,
  })]));
  const names = Object.fromEntries(chosen.map((i) => [i.id, i.name || i.id]));

  return {
    ok: true,
    result: {
      dataMode: 'simulation',
      label: 'Simulated controlled benchmark - not a real-world measurement',
      generatedAt: new Date(now()).toISOString(),
      runtimeMs: now() - started,
      parameters: {
        ...params,
        scenarioLabel: SCENARIO_BY_ID[params.scenario].label,
        measuredSeconds: params.durationSeconds - params.warmupSeconds,
        surge: surgeWindow(params),
        vehiclesEntered: runs.fixed.network.vehiclesEntered,
        emergencyRoute: route ? route.map((p) => p.id) : null,
        topology: { links: topology.links.length, linkLengthM: topology.linkLengthM, capacity: topology.capacity },
        timing: { ...config.timing },
        weights: { ...config.weights },
        network: { ...(config.network || {}) },
      },
      method: {
        fixed: `Fixed-time plan: the decision engine without observations (${config.timing.FALLBACK_GREEN_TIME} s green per approach in turn, `
          + `${config.timing.YELLOW_TIME} s yellow, ${config.timing.ALL_RED_TIME} s all-red).`,
        local: 'Per-intersection adaptive control: the same engine fed one observation per intersection per second; '
          + 'each intersection decides from its own queues only. Emergency priority only where a camera sees the vehicle (within 60 m).',
        network: 'Network-aware control: as "local", plus the network coordinator every '
          + `${(config.network && config.network.DECISION_INTERVAL) || 2} s - downstream capacity, spillback guard, upstream platoons, `
          + 'and a staged emergency corridor over the next intersections on the vehicle\'s route.',
        demand: 'Identical seeded arrivals for every policy (the Simulation tab demand model); vehicles released at one intersection '
          + `drive ${topology.linkLengthM} m to the next; a road holds at most ${topology.capacity} vehicles; deterministic discharge.`,
        notModelled: 'Pedestrians, turning movements, lane changes, and real-world variability in driver behaviour.',
      },
      policies: runs,
      improvementPercent: {
        networkVsLocal: compare(runs.local.network, runs.network.network),
        networkVsFixed: compare(runs.fixed.network, runs.network.network),
        localVsFixed: compare(runs.fixed.network, runs.local.network),
      },
      perIntersection: params.intersectionIds.map((id) => ({
        intersectionId: id,
        name: names[id],
        ...Object.fromEntries(POLICIES.map((p) => [p, runs[p].perIntersection[id]])),
      })),
    },
  };
}

/**
 * Runs the benchmark in a worker thread so the live engine, ingestion and
 * Socket.IO never wait for it. Resolves to the same { ok, result } /
 * { ok: false, errors }.
 */
function runBenchmarkInWorker(options) {
  // eslint-disable-next-line global-require
  const { Worker } = require('worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: options });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`benchmark worker exited with code ${code}`));
    });
  });
}

// Worker entry point (see runBenchmarkInWorker).
const threads = require('worker_threads');
if (!threads.isMainThread && threads.workerData && threads.workerData.intersections) {
  threads.parentPort.postMessage(runBenchmark(threads.workerData));
}

module.exports = {
  runBenchmark, runBenchmarkInWorker, improvementPercent, LIMITS, POLICIES, METRICS,
};
