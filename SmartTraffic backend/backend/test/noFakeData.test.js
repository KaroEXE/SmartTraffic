// Live views must show only data that came from the AI service. Simulated
// data is allowed in exactly one place: the Simulation tab (its generator
// services/simulationService.js, its HTTP controls and the dashboard's
// Simulation mode). This scans every runtime source file (not tests) so
// random numbers, generators or sample data cannot creep into the live path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'docs']);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function runtimeFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) runtimeFiles(full, out);
    } else if (/\.(js|html|json)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)
      && entry.name !== 'package-lock.json') {
      out.push(full);
    }
  }
  return out;
}

const files = ['backend', 'frontend'].flatMap((d) => runtimeFiles(path.join(ROOT, d)));
const source = (f) => fs.readFileSync(f, 'utf8');

// The simulator itself, and the only modules allowed to load it.
const SIMULATOR = 'backend/services/simulationService.js';
const MAY_LOAD_SIMULATION = new Set([
  'backend/server.js', // wiring: separate engine, store, routes and socket room
  'backend/controllers/simulationController.js',
  'backend/docs/openapi.js', // lists the scenario ids
  'frontend/app.js', // the dashboard's mode switch
]);

test('random numbers exist only in the simulator', () => {
  const hits = files.filter((f) => /Math\.random|crypto\.random(?!UUID)|randomInt/.test(source(f)));
  assert.deepEqual(hits.map(rel), [SIMULATOR]);
});

test('only the simulation wiring loads the simulator or its controls', () => {
  const loads = /require\([^)]*(simulationService|simulationController)[^)]*\)|from\s+['"][^'"]*(simControls|modeStore)\.js['"]/;
  const hits = files.map(rel).filter((f) => loads.test(source(path.join(ROOT, f))));
  for (const f of hits) assert.ok(MAY_LOAD_SIMULATION.has(f), `${f} must not load simulation code`);
});

test('live views never import simulation code', () => {
  const live = ['frontend/liveAI.js', 'frontend/dashboard.js', 'frontend/map.js',
    'frontend/three/scene.js', 'frontend/three/vehicles.js', 'frontend/three/pedestrians.js',
    'frontend/three/trafficLights.js', 'frontend/three/intersection.js',
    'backend/controllers/trafficController.js', 'backend/services/trafficDecisionService.js',
    'backend/services/trafficStateService.js', 'backend/utils/validation.js'];
  for (const f of live) {
    assert.doesNotMatch(source(path.join(ROOT, f)), /simulationService|simControls|modeStore|sampleTraffic/, f);
  }
});

test('no sample data or mock client in the runtime tree', () => {
  assert.deepEqual(files.map(rel).filter((f) => /sampleTraffic|mockClient/.test(f)), []);
  assert.equal(fs.existsSync(path.join(ROOT, 'backend/utils/sampleTraffic.json')), false);
});

test('the live channel manages only the intersection the AI service reports', () => {
  assert.deepEqual(require('../config/intersections').map((i) => i.id), ['main']);
});
