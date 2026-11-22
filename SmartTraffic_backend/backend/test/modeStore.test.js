// Dashboard mode switching (frontend/modeStore.js) - the logic behind the
// "Live traffic" / "Simulation" tabs, tested without a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'modeStore.js')).href);

const snap = (intersectionId, dataMode, extra = {}) => ({ intersectionId, dataMode, ...extra });

test('starts in live mode and switches tabs explicitly', async () => {
  const { createModeStore } = await load();
  const store = createModeStore();
  assert.equal(store.mode, 'live');
  assert.equal(store.apiBase(), '/api');

  assert.equal(store.switchMode('simulation'), true);
  assert.equal(store.mode, 'simulation');
  assert.equal(store.apiBase(), '/api/simulation');
  assert.equal(store.switchMode('simulation'), false, 'same tab again is not a change');
  assert.equal(store.switchMode('live'), true);
  assert.throws(() => store.switchMode('both'), /Unknown mode/);
  assert.equal(store.mode, 'live');
});

test('each mode keeps its own data; switching tabs never mixes them', async () => {
  const { createModeStore } = await load();
  const store = createModeStore();
  store.select('main');

  assert.equal(store.accept(snap('main', 'live', { vehicles: 4 })), true, 'live data renders in live mode');
  assert.equal(store.accept(snap('main', 'simulation', { vehicles: 40 })), false, 'simulated data is not rendered in live mode');
  assert.equal(store.get().vehicles, 4, 'simulated data did not overwrite live data');

  store.switchMode('simulation');
  assert.equal(store.get().vehicles, 40);
  assert.deepEqual(store.all().map((s) => s.dataMode), ['simulation']);
  assert.equal(store.accept(snap('main', 'live', { vehicles: 5 })), false, 'live data is not rendered in simulation mode');
  assert.equal(store.get().vehicles, 40);

  store.switchMode('live');
  assert.equal(store.get().vehicles, 5, 'live view shows the latest live data after switching back');
  assert.ok(store.all().every((s) => s.dataMode === 'live'));
});

test('payloads without dataMode count as live, never as simulation', async () => {
  const { createModeStore } = await load();
  const store = createModeStore('simulation');
  store.select('main');
  assert.equal(store.accept({ intersectionId: 'main' }), false);
  assert.equal(store.get(), undefined);
  assert.equal(store.size('live'), 1);
});

test('init / reset replace only their own mode', async () => {
  const { createModeStore } = await load();
  const store = createModeStore();
  store.replaceAll('live', [snap('main', 'live'), snap('second', 'live')]);
  store.replaceAll('simulation', [snap('main', 'simulation'), snap('rogue', 'live')]);
  assert.equal(store.size('live'), 2, 'simulation init did not touch live');
  assert.equal(store.size('simulation'), 1, 'a payload declaring another mode is not filed under simulation');

  // A simulation reset clears simulation state only.
  assert.equal(store.replaceAll('simulation', []), false, 'live is the active mode');
  assert.equal(store.size('simulation'), 0);
  assert.equal(store.size('live'), 2);
});

test('event log entries are shown only for the active mode and selected intersection', async () => {
  const { createModeStore } = await load();
  const store = createModeStore();
  store.select('main');
  assert.equal(store.isCurrentEvent({ dataMode: 'live', intersectionId: 'main' }), true);
  assert.equal(store.isCurrentEvent({ dataMode: 'simulation', intersectionId: 'main' }), false);
  assert.equal(store.isCurrentEvent({ dataMode: 'live', intersectionId: 'second' }), false);
  store.switchMode('simulation');
  assert.equal(store.isCurrentEvent({ dataMode: 'simulation', intersectionId: 'main' }), true);
  assert.equal(store.isCurrentEvent({ intersectionId: 'main' }), false, 'unlabelled (live) events stay out of the simulation log');
});
