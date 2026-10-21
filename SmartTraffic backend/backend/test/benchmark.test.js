// Controlled benchmark (services/simulationBenchmark.js): fixed-time,
// per-intersection adaptive and network-aware control on identical
// simulated network demand. Simulated data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const config = require('../config');
const simulationIntersections = require('../config/simulationIntersections');
const { runBenchmark, improvementPercent, METRICS } = require('../services/simulationBenchmark');
const { createSimulationService } = require('../services/simulationService');
const { createSimulationController } = require('../controllers/simulationController');
const { createSimulationRoutes } = require('../routes/trafficRoutes');
const { createTrafficController } = require('../controllers/trafficController');
const { createTrafficDecisionService } = require('../services/trafficDecisionService');

const run = (options = {}) => {
  const r = runBenchmark({ intersections: simulationIntersections, config, durationSeconds: 420, ...options });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.result;
};

test('improvement percentages use the stated formulas and never divide by zero', () => {
  // Lower is better: (baseline - optimized) / baseline x 100
  assert.equal(improvementPercent(40, 30), 25);
  assert.equal(improvementPercent(30, 40), -33.3, 'a worse result is reported as negative, not hidden');
  // Higher is better (throughput): (optimized - baseline) / baseline x 100
  assert.equal(improvementPercent(200, 250, { higherIsBetter: true }), 25);
  assert.equal(improvementPercent(250, 200, { higherIsBetter: true }), -20);
  assert.equal(improvementPercent(0, 5), null, 'zero baseline: not computable');
  assert.equal(improvementPercent(null, 5), null);
  assert.equal(improvementPercent(5, undefined), null);
});

test('three policies on identical demand; each really runs its control mode', () => {
  const r = run({ profile: 'surge', ambulance: true });
  assert.equal(r.dataMode, 'simulation');
  assert.match(r.label, /Simulated/);
  const { fixed, local, network } = r.policies;
  assert.deepEqual(fixed.controllerModes, ['FALLBACK'], 'fixed = engine without observations');
  assert.ok(!local.controllerModes.includes('FALLBACK') && !network.controllerModes.includes('FALLBACK'));
  assert.equal(local.decisionsMade, 0, 'local: no network coordinator');
  assert.ok(network.decisionsMade > 100, 'network: coordinator ran every decision interval');

  // Same vehicles entered the network in every run.
  for (const p of [fixed, local, network]) assert.equal(p.network.vehiclesEntered, r.parameters.vehiclesEntered);
  for (const p of [fixed, local, network]) {
    const n = p.network;
    for (const k of ['averageWaitSeconds', 'maxWaitSeconds', 'totalWaitVehicleHours', 'averageQueue']) assert.ok(n[k] >= 0, k);
    assert.ok(Number.isInteger(n.spillbackSeconds) && Number.isInteger(n.spillbackIncidents));
    assert.ok(n.spillbackIncidents <= n.spillbackSeconds);
  }

  // Every reported improvement is exactly the formula applied to the measurements.
  for (const [pair, [a, b]] of Object.entries({ networkVsLocal: [local, network], networkVsFixed: [fixed, network], localVsFixed: [fixed, local] })) {
    for (const [metric, higher] of Object.entries(METRICS)) {
      assert.equal(r.improvementPercent[pair][metric],
        improvementPercent(a.network[metric], b.network[metric], { higherIsBetter: higher }), `${pair}.${metric}`);
    }
  }

  // The emergency vehicle drove the same route in every run.
  assert.deepEqual(r.parameters.emergencyRoute, ['main', 'market-square', 'stadium-road']);
  for (const p of [fixed, local, network]) assert.deepEqual(p.emergency.route, r.parameters.emergencyRoute);
  assert.ok(network.emergency.finished, 'the ambulance completed its route');
  assert.ok(network.emergency.stops <= fixed.emergency.stops);
  assert.equal(r.perIntersection.length, simulationIntersections.length);
  assert.equal(network.series.length, fixed.series.length);
});

test('the benchmark is repeatable: same seed, same result; another seed, other demand', () => {
  const strip = (r) => JSON.stringify({ p: r.policies, i: r.improvementPercent });
  assert.equal(strip(run({ seed: 11 })), strip(run({ seed: 11 })));
  assert.notEqual(run({ seed: 11 }).parameters.vehiclesEntered, run({ seed: 12 }).parameters.vehiclesEntered);
});

test('invalid benchmark parameters are rejected with reasons', () => {
  const bad = (options) => runBenchmark({ intersections: simulationIntersections, config, ...options });
  assert.match(bad({ scenario: 'gridlock' }).errors.join(), /scenario must be one of/);
  assert.match(bad({ scenario: 'ambulance-north' }).errors.join(), /scenario must be one of/);
  assert.match(bad({ durationSeconds: 99999 }).errors.join(), /durationSeconds/);
  assert.match(bad({ durationSeconds: 200, warmupSeconds: 180 }).errors.join(), /at least 60 s/);
  assert.match(bad({ seed: -1 }).errors.join(), /seed/);
  assert.match(bad({ profile: 'rush' }).errors.join(), /profile/);
  assert.match(bad({ ambulance: 'yes' }).errors.join(), /ambulance/);
  assert.match(bad({ intersectionIds: ['atlantis'] }).errors.join(), /intersectionIds/);
  assert.equal(bad({ intersectionIds: ['main'], durationSeconds: 200 }).result.perIntersection.length, 1);
});

test('surge profile measures how long congestion takes to clear', () => {
  const r = run({ profile: 'surge', durationSeconds: 900 });
  assert.deepEqual(r.parameters.surge, { start: 180, end: 450 });
  for (const p of Object.values(r.policies)) {
    assert.equal(typeof p.network.clearedWithinRun, 'boolean');
    if (p.network.clearedWithinRun) assert.ok(p.network.clearSeconds >= 0);
    else assert.equal(p.network.clearSeconds, null, 'not cleared: no invented value');
  }
  assert.equal(run({ profile: 'steady' }).policies.network.network.clearSeconds, null);
});

test('benchmark HTTP endpoints: null before a run, labelled simulated result after (worker thread), live untouched', async () => {
  const simulation = createSimulationService({ intersections: simulationIntersections, config });
  const live = createTrafficDecisionService({ intersections: require('../config/intersections'), config });
  const app = express();
  app.use(express.json());
  app.use('/api/simulation', createSimulationRoutes(
    createTrafficController(simulation.engine, { stateService: simulation.stateService }),
    createSimulationController(simulation),
  ));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/simulation`;
  const post = (body) => fetch(`${base}/benchmark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const before = await fetch(`${base}/benchmark`);
    assert.equal(before.status, 200);
    assert.equal((await before.json()).benchmark, null, 'nothing measured yet - no invented result');
    assert.equal((await post({ durationSeconds: 5 })).status, 400);
    const [res, busy] = await Promise.all([
      post({
        scenario: 'heavy-east', durationSeconds: 300, seed: 3, profile: 'surge', ambulance: true,
      }),
      new Promise((r) => { setTimeout(() => r(post({})), 20); }),
    ]);
    assert.equal(busy.status, 409, 'one run at a time');
    assert.equal(res.status, 200);
    const { benchmark } = await res.json();
    assert.equal(benchmark.dataMode, 'simulation');
    assert.equal(benchmark.parameters.scenario, 'heavy-east');
    assert.equal(benchmark.parameters.profile, 'surge', 'every option reaches the run');
    assert.equal(benchmark.parameters.ambulance, true);
    // The worker computes exactly what the in-process function computes.
    const local = runBenchmark({
      intersections: simulationIntersections, config, scenario: 'heavy-east', durationSeconds: 300, seed: 3, profile: 'surge', ambulance: true,
    });
    assert.deepEqual(benchmark.improvementPercent, local.result.improvementPercent);
    const latest = await (await fetch(`${base}/benchmark`)).json();
    assert.equal(latest.benchmark.generatedAt, benchmark.generatedAt);
    assert.equal(simulation.state, 'stopped', 'the running simulation is not started or changed');
    assert.ok(live.getAllSnapshots().every((s) => s.updatesReceived === 0), 'live engine saw nothing');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
