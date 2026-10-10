// Live camera wiring: AI_STREAM_URL normalisation (config/index.js) and the
// 3D vehicle system's live / fallback behaviour (frontend/three/vehicles.js),
// tested without a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { register } = require('node:module');

// The browser resolves the bare 'three' import with an import map; do the same here.
const threeUrl = pathToFileURL(require.resolve('three')).href.replace(/three\.cjs$/, 'three.module.js');
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === 'three') return next(${JSON.stringify(threeUrl)}, context);
    return next(specifier, context);
  }`)}`);

const frontend = (file) => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', file)).href);

function aiStreamUrl(value) {
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./config').aiStreamUrl)"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AI_STREAM_URL: value, MONGODB_URI: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('AI_STREAM_URL becomes the AI service base URL the browser can use', () => {
  assert.equal(aiStreamUrl(''), '');
  assert.equal(aiStreamUrl('http://127.0.0.1:5000'), 'http://127.0.0.1:5000');
  assert.equal(aiStreamUrl('https://ai.example.onrender.com/'), 'https://ai.example.onrender.com');
  // An older single-stream value is reduced to the base; credentials never reach browsers.
  assert.equal(aiStreamUrl('https://user:secret@ai.example/video/north?token=x'), 'https://ai.example');
  assert.equal(aiStreamUrl('http://ai.example:5000/video_feed'), 'http://ai.example:5000');
  assert.equal(aiStreamUrl('ftp://ai.example'), '');
});

const ALL_GREEN = { north: 'GREEN', south: 'GREEN', east: 'GREEN', west: 'GREEN' };
const traffic = (n) => ({
  north: { vehicles: n }, south: { vehicles: n }, east: { vehicles: n }, west: { vehicles: n },
});

async function vehicleSystem() {
  const THREE = await import(threeUrl);
  const { VehicleSystem } = await frontend('three/vehicles.js');
  const parent = new THREE.Group();
  const system = new VehicleSystem(parent);
  const run = (seconds) => {
    for (let t = 0; t < seconds; t += 0.05) system.update(0.05, t, () => false);
  };
  return { system, parent, run };
}

test('live counts drive the vehicles; repeated updates reuse models instead of piling up', async () => {
  const { system, run } = await vehicleSystem();
  system.setSignals(ALL_GREEN);
  system.setDemand(traffic(8));
  run(60);
  const settled = system.count();
  assert.ok(settled > 0, 'vehicles appear for live counts');

  // Twenty minutes of updates at the AI service's rate, counts changing as the videos play.
  const sizes = [];
  for (let k = 0; k < 1200; k += 1) {
    system.setDemand(traffic(4 + (k % 9)));
    run(1);
    sizes.push(system.count() + system.pooledCount());
  }
  // Every vehicle object ever created is either on the road or idle in the pool: bounded.
  assert.ok(Math.max(...sizes) <= 4 * 2 * 40, `objects stay bounded (max ${Math.max(...sizes)})`);
  assert.ok(system.pooledCount() > 0, 'removed vehicles are kept for reuse');
  assert.ok(system.group.children.length === system.count(), 'no detached models left in the scene');
});

test('fallback spawns nothing from stale counts and lets existing vehicles drain', async () => {
  const { system, run } = await vehicleSystem();
  system.setSignals(ALL_GREEN);
  system.setDemand(traffic(10));
  run(30);
  assert.ok(system.count() > 0);
  system.setDemand(null); // what the scene passes in fallback
  run(60);
  assert.equal(system.count(), 0, 'no stuck vehicles once live data stops');
  system.setDemand(traffic(6)); // live data resumes
  run(20);
  assert.ok(system.count() > 0, 'vehicles return with live data');
});

test('counts that drop after a video loop shrink the queue instead of double counting', async () => {
  const { system, run } = await vehicleSystem();
  // One approach green at a time, like the backend's single-approach phasing.
  const cycle = (seconds) => {
    for (let t = 0; t < seconds; t += 8) {
      const green = ['north', 'east', 'south', 'west'][Math.floor(t / 8) % 4];
      system.setSignals({ north: 'RED', south: 'RED', east: 'RED', west: 'RED', [green]: 'GREEN' });
      run(8);
    }
  };
  system.setDemand(traffic(12));
  cycle(40);
  system.setDemand(traffic(1)); // the video restarted on a quieter frame
  cycle(96);
  for (const dir of ['north', 'south', 'east', 'west']) {
    assert.ok(system.countOnApproach(dir) <= 1, `${dir} follows the new count`);
  }
});

const ALL_RED = { north: 'RED', south: 'RED', east: 'RED', west: 'RED' };
const kindsOn = (system, dir) => system.lanes[dir].flat().filter((v) => !v.passed && !v.ev)
  .map((v) => (v.kind === 'suv' ? 'car' : v.kind)).sort();

test('each approach shows exactly its detected count, with models from the detected classes', async () => {
  const { system, run } = await vehicleSystem();
  system.setSignals(ALL_RED);
  system.setDemand({
    north: { vehicles: 5, classes: { car: 3, bus: 1, truck: 1 } },
    south: { vehicles: 2, classes: { motorcycle: 2 } },
    east: { vehicles: 0, classes: {} },
    west: { vehicles: null, available: false }, // camera video unavailable
  });
  run(30);
  assert.equal(system.countOnApproach('north'), 5);
  assert.deepEqual(kindsOn(system, 'north'), ['bus', 'car', 'car', 'car', 'truck']);
  assert.deepEqual(kindsOn(system, 'south'), ['motorcycle', 'motorcycle']);
  assert.equal(system.countOnApproach('east'), 0);
  assert.equal(system.countOnApproach('west'), 0, 'no vehicles are drawn for an unavailable camera');
});

test('a lower count (e.g. the video looped) removes the extra vehicles at once, even at red', async () => {
  const { system, run } = await vehicleSystem();
  system.setSignals(ALL_RED);
  system.setDemand(traffic(9));
  run(30);
  assert.equal(system.countOnApproach('north'), 9);
  system.setDemand(traffic(2));
  assert.equal(system.countOnApproach('north'), 2, 'no stuck or duplicated vehicles after the drop');
  run(30);
  assert.equal(system.countOnApproach('north'), 2);
  assert.equal(system.group.children.length, system.count(), 'removed models leave the scene');
});

test('the scene is deterministic: the same data gives the same vehicles', async () => {
  const picture = async () => {
    const { system, run } = await vehicleSystem();
    system.setSignals(ALL_RED);
    system.setDemand({ ...traffic(6), north: { vehicles: 6, classes: { car: 4, bus: 2 } } });
    run(20);
    return ['north', 'south', 'east', 'west'].map((d) => system.lanes[d].flat()
      .map((v) => `${v.kind}@${v.s.toFixed(2)}#${v.group.children[0].material.color.getHexString()}`).join(','));
  };
  assert.deepEqual(await picture(), await picture());
});

test('class mix rounds to exactly the shown total', async () => {
  const { kindMix } = await frontend('three/vehicles.js');
  assert.deepEqual(kindMix({ car: 20, bus: 4, truck: 3 }, 14), { car: 10, bus: 2, truck: 2, motorcycle: 0 });
  assert.deepEqual(kindMix(null, 3), { car: 3, bus: 0, truck: 0, motorcycle: 0 });
  assert.deepEqual(kindMix({ 'police car': 2 }, 2), { car: 2, bus: 0, truck: 0, motorcycle: 0 });
});

test('dashboard approach cards: numbers only for live data, otherwise the reason', async () => {
  const { approachView } = await frontend('dashboard.js');
  const t = { vehicles: 4, queueLength: 2, waiting: 3.5, available: true };
  assert.equal(approachView(t, 'live').vehicles, 4);
  assert.deepEqual(approachView(t, 'waiting'), { vehicles: null, note: 'Waiting for live data', state: 'nodata' });
  assert.deepEqual(approachView({ vehicles: null, available: false }, 'live'),
    { vehicles: null, note: 'Video unavailable', state: 'unavailable' });
  const stale = approachView(t, 'stale');
  assert.equal(stale.vehicles, 4, 'last real value kept...');
  assert.equal(stale.state, 'stale', '...and marked stale');
});
