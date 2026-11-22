// Live AI view states (frontend/streamStatus.js): loading, offline, stale,
// connected and error for the AI feed and the camera streams, tested without
// a browser. Inputs are MOCKED snapshots / status payloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'streamStatus.js')).href);

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ago = (s) => new Date(NOW - s * 1000).toISOString();

test('AI feed: loading, offline, connected, stale, error and simulation', async () => {
  const { describeFeed } = await load();
  assert.equal(describeFeed(null).state, 'loading');
  assert.equal(describeFeed(null, { connected: false }).state, 'error');
  assert.equal(describeFeed({ dataMode: 'live', aiStatus: 'WAITING' }).state, 'offline');

  const live = describeFeed({ dataMode: 'live', aiStatus: 'CONNECTED', lastUpdate: '2026-10-09T11:59:58Z' });
  assert.equal(live.state, 'connected');
  assert.match(live.detail, /11:59:58/);

  const stale = describeFeed({ dataMode: 'live', aiStatus: 'STALE', lastUpdate: '2026-10-09T11:50:00Z' });
  assert.equal(stale.state, 'stale');
  assert.match(stale.detail, /fixed-time fallback/);

  // Simulated data is never presented as live AI data.
  assert.equal(describeFeed({ dataMode: 'simulation', aiStatus: 'CONNECTED' }).state, 'offline');
  assert.equal(describeFeed({ dataMode: 'live', aiStatus: 'CONNECTED' }, { mode: 'simulation' }).state, 'offline');
});

test('camera streams: unknown, online, stale, offline, disabled', async () => {
  const { describeStream } = await load();
  const base = { id: 's', name: 'S', enabled: true, active: true, status: 'online', lastHealthCheckAt: ago(10), lastFrameAt: ago(2) };

  assert.equal(describeStream({ ...base, status: 'unknown', lastHealthCheckAt: null }, NOW).state, 'unknown');
  const online = describeStream(base, NOW);
  assert.equal(online.state, 'online');
  assert.match(online.detail, /Feeding - last frame 2 s ago/);

  // A report older than staleAfterSeconds is not shown as online, even if it said so.
  const stale = describeStream({ ...base, lastHealthCheckAt: ago(120) }, NOW, 60);
  assert.equal(stale.state, 'stale');
  assert.match(stale.detail, /Last report 2 min ago \(online\)/);
  assert.equal(describeStream({ ...base, stale: true }, NOW).state, 'stale', 'server-side stale flag is respected');

  const offline = describeStream({ ...base, status: 'offline', active: false, lastError: 'read timeout' }, NOW);
  assert.equal(offline.state, 'offline');
  assert.match(offline.detail, /Not feeding.*read timeout/);
  assert.equal(describeStream({ ...base, enabled: false }, NOW).state, 'disabled');
});

test('stream panel: loading, error, registry unavailable, empty and rows for the selected intersection', async () => {
  const { streamRows, serverNow } = await load();
  assert.equal(streamRows({ loading: true }, 'main', NOW).state, 'loading');
  assert.equal(streamRows({ loading: false, error: 'down' }, 'main', NOW).state, 'error');
  assert.equal(streamRows({ loading: false, status: { available: false, streams: [] } }, 'main', NOW).state, 'offline');

  const status = {
    available: true,
    serverTime: new Date(NOW).toISOString(),
    staleAfterSeconds: 60,
    streams: [
      { id: 'b', name: 'B', intersectionId: 'main', direction: 'south', priority: 0, enabled: true, status: 'online', lastHealthCheckAt: ago(5) },
      { id: 'a2', name: 'A2', intersectionId: 'main', direction: 'north', priority: 2, enabled: true, status: 'standby', lastHealthCheckAt: ago(5) },
      { id: 'a1', name: 'A1', intersectionId: 'main', direction: 'north', priority: 1, enabled: true, status: 'online', lastHealthCheckAt: ago(5) },
      { id: 'x', name: 'X', intersectionId: 'market-square', direction: 'north', priority: 0, enabled: true, status: 'online', lastHealthCheckAt: ago(5) },
    ],
  };
  const view = streamRows({ loading: false, status }, 'main', NOW);
  assert.equal(view.state, 'ok');
  assert.deepEqual(view.rows.map((r) => r.stream.id), ['a1', 'a2', 'b'], 'this intersection only, by direction then priority');
  assert.equal(streamRows({ loading: false, status }, 'ring-road-north', NOW).state, 'empty');

  // Client clock skew does not change what counts as stale.
  const received = 1_000;
  assert.equal(serverNow(status, received, received + 5000), NOW + 5000);
});
