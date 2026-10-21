// Shared traffic figures (frontend/metrics.js) used by the map, the 3D
// labels and the dashboard: congestion is only shown for usable data.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const metrics = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'metrics.js')).href);

const approach = (vehicles, queueLength, waitingTime) => ({ vehicles, queueLength, waitingTime, available: true });
const live = (traffic, extra = {}) => ({ dataMode: 'live', aiStatus: 'CONNECTED', traffic, ...extra });

test('congestion level follows the longest queue; numbers come from the snapshot', async () => {
  const { trafficSummary } = await metrics();
  const s = trafficSummary(live({
    north: approach(6, 4, 12.5), south: approach(2, 1, 3), east: approach(9, 7, 20), west: approach(0, 0, 0),
  }));
  assert.equal(s.level, 'moderate');
  assert.equal(s.label, 'Moderate');
  assert.equal(s.source, 'live');
  assert.deepEqual([s.vehicles, s.queued, s.maxQueue, s.maxWait, s.approaches], [17, 12, 7, 20, 4]);

  assert.equal(trafficSummary(live({ north: approach(1, 4, 1) })).level, 'free');
  assert.equal(trafficSummary(live({ north: approach(20, 12, 1) })).level, 'heavy');
});

test('no data, stale data and a lost connection never produce a level or a zero', async () => {
  const { trafficSummary } = await metrics();
  const cases = [
    [null, {}, 'nodata'],
    [live({ north: approach(5, 5, 5) }, { aiStatus: 'WAITING' }), {}, 'nodata'],
    [live({ north: approach(5, 5, 5) }, { aiStatus: 'STALE' }), {}, 'stale'],
    [live({ north: approach(5, 5, 5) }), { connected: false }, 'offline'],
    // Connected, but every camera unavailable.
    [live({ north: { vehicles: null, queueLength: null, available: false } }), {}, 'nodata'],
  ];
  for (const [snap, options, level] of cases) {
    const s = trafficSummary(snap, options);
    assert.equal(s.level, level);
    assert.equal(s.vehicles, null, 'no number is shown');
    assert.equal(s.queued, null);
  }
});

test('simulated snapshots are summarised and labelled as simulated', async () => {
  const { trafficSummary } = await metrics();
  const s = trafficSummary({ dataMode: 'simulation', aiStatus: 'CONNECTED', traffic: { east: approach(3, 2, 4) } });
  assert.equal(s.source, 'simulated');
  assert.equal(s.queued, 2);
});

test('improvements and positions are formatted honestly', async () => {
  const { formatImprovement, positionLabel } = await metrics();
  assert.equal(formatImprovement(34.66), '+34.7%');
  assert.equal(formatImprovement(-4), '−4.0%');
  assert.equal(formatImprovement(null), 'n/a');
  assert.equal(formatImprovement(0), '0.0%');
  assert.equal(positionLabel({ positionSource: 'placeholder' }), 'Approximate position - not surveyed');
  assert.equal(positionLabel({ positionSource: 'surveyed' }), null);
  assert.equal(positionLabel({ dataMode: 'simulation' }), 'Simulated position');
});
