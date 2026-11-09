// OpenStreetMap proxy: identifies itself, fails over, caches, and only runs
// queries it builds itself. Upstream is stubbed - no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createOsmProxyService } = require('../services/osmProxyService');
const { createOsmRoutes } = require('../routes/osmRoutes');

const BBOX = { south: 35.54, west: 45.4, north: 35.59, east: 45.46 };
const UA = 'SmartTraffic-test/1.0';

function stubFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const a = answers[calls.length - 1] ?? answers.at(-1);
    if (a instanceof Error) throw a;
    return { ok: a.status === 200, status: a.status, json: async () => a.body };
  };
  return { calls, fetchImpl };
}

test('sends an identifying User-Agent and a query built by the server', async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: { elements: [{ type: 'node', id: 1 }] } }]);
  const osm = createOsmProxyService({ urls: ['https://a.example/api'], userAgent: UA, fetchImpl });
  const json = await osm.fetchLayer('hazards', BBOX);
  assert.deepEqual(json, { elements: [{ type: 'node', id: 1 }] });
  assert.equal(calls[0].init.headers['User-Agent'], UA);
  const query = new URLSearchParams(calls[0].init.body).get('data');
  assert.match(query, /node\["highway"="speed_camera"\]\(35\.54,45\.4,35\.59,45\.46\)/);
});

test('fails over to the next instance and caches the answer', async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 406 }, new TypeError('fetch failed'), { status: 200, body: { elements: [] } }]);
  const osm = createOsmProxyService({ urls: ['https://a.example', 'https://b.example', 'https://c.example'], userAgent: UA, fetchImpl });
  await osm.fetchLayer('places', BBOX);
  assert.deepEqual(calls.map((c) => c.url), ['https://a.example', 'https://b.example', 'https://c.example']);
  await osm.fetchLayer('places', { ...BBOX, south: 35.5401 }); // same ~100 m cell
  assert.equal(calls.length, 3, 'served from cache');
});

test('after every instance failed, answers at once for a minute instead of waiting again', async () => {
  const { calls, fetchImpl } = stubFetch([new TypeError('fetch failed')]);
  let now = 0;
  const osm = createOsmProxyService({ urls: ['https://a.example'], userAgent: UA, fetchImpl, now: () => now });
  await assert.rejects(osm.fetchLayer('hazards', BBOX), (e) => e.code === 'upstream');
  await assert.rejects(osm.fetchLayer('places', BBOX), (e) => e.code === 'upstream');
  assert.equal(calls.length, 1, 'second request not sent upstream');
  now += 61000;
  await assert.rejects(osm.fetchLayer('places', BBOX));
  assert.equal(calls.length, 2, 'tried again after a minute');
});

test('HTTP: bad layer or area is refused; all instances down is a 502', async () => {
  const { fetchImpl } = stubFetch([{ status: 429 }]);
  const app = express();
  app.use('/api', createOsmRoutes(createOsmProxyService({ urls: ['https://a.example'], userAgent: UA, fetchImpl })));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/osm`;
  const q = (b) => `?south=${b.south}&west=${b.west}&north=${b.north}&east=${b.east}`;
  try {
    assert.equal((await fetch(`${base}/anything${q(BBOX)}`)).status, 400);
    assert.equal((await fetch(`${base}/hazards${q({ south: 30, west: 40, north: 38, east: 48 })}`)).status, 400, 'too large');
    assert.equal((await fetch(`${base}/hazards?south=x`)).status, 400);
    const down = await fetch(`${base}/hazards${q(BBOX)}`);
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /not reachable/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('during an outage the last good answer for the area is served, however old', async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 200, body: { elements: [{ type: 'node', id: 7 }] } }, new TypeError('fetch failed')]);
  let now = 0;
  const osm = createOsmProxyService({ urls: ['https://a.example'], userAgent: UA, fetchImpl, now: () => now, cacheTtlMs: 1000 });
  assert.deepEqual(await osm.fetchLayer('hazards', BBOX), { elements: [{ type: 'node', id: 7 }] });
  now += 5000; // stale, so it is refreshed - and the refresh fails
  assert.deepEqual(await osm.fetchLayer('hazards', BBOX), { elements: [{ type: 'node', id: 7 }] }, 'stale answer instead of an error');
  assert.deepEqual(await osm.fetchLayer('hazards', BBOX), { elements: [{ type: 'node', id: 7 }] }, 'and again without asking upstream');
  assert.equal(calls.length, 2);
  await assert.rejects(osm.fetchLayer('places', BBOX), (e) => e.code === 'upstream', 'nothing stored for another layer');
});
