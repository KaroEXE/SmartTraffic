// Camera stream registry, authenticated ingestion with stream attribution,
// sampled persistence and latest-state reads.
//
// Runs a real Express app (real routes, controllers, validation, registry,
// history service and decision engine) on an ephemeral port. MongoDB is
// MOCKED: the models are in-memory fakes, and every document they accept is
// first checked against the real mongoose schema with validateSync(). AI
// payloads are MOCKED test observations, not output of the Python service.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const config = require('../config');
const intersections = require('../config/intersections');
const TrafficStream = require('../models/TrafficStream');
const TrafficRecord = require('../models/TrafficRecord');
const { createTrafficDecisionService } = require('../services/trafficDecisionService');
const { createTrafficStateService } = require('../services/trafficStateService');
const { createTrafficHistoryService } = require('../services/trafficHistoryService');
const { createStreamRegistryService } = require('../services/streamRegistryService');
const { createTrafficController } = require('../controllers/trafficController');
const { createStreamController } = require('../controllers/streamController');
const { createTrafficRoutes, createStreamRoutes } = require('../routes/trafficRoutes');
const { bindTrafficEvents } = require('../socket/trafficSocket');
const { validateStreamInput, sanitizeError } = require('../utils/streamValidation');
const SAMPLE = require('./fixtures/sampleTraffic.json');

const INGEST = 'test-ingest-token';
const ADMIN = 'test-admin-token';
const YT = 'https://www.youtube.com/watch?v=abc123&token=private-yt-token';

// --------------------------------------------------------------- fakes

/** In-memory TrafficStream with the real schema's validation and the unique indexes. */
function fakeStreamModel() {
  const rows = new Map();
  const validated = (doc) => {
    const m = new TrafficStream(doc);
    const err = m.validateSync();
    if (err) throw err;
    return m.toObject();
  };
  const duplicate = (doc) => [...rows.values()].some((r) => r._id !== doc._id
    && r.url === doc.url && r.intersectionId === doc.intersectionId && r.direction === doc.direction);
  const e11000 = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
  const chain = (promise) => ({ lean: () => promise });
  return {
    rows,
    find: () => chain(Promise.resolve([...rows.values()].map((r) => structuredClone(r)))),
    async create(doc) {
      const obj = validated(doc);
      if (rows.has(obj._id) || duplicate(obj)) throw e11000();
      obj.createdAt = new Date();
      obj.updatedAt = obj.createdAt;
      rows.set(obj._id, obj);
      return structuredClone(obj);
    },
    findOneAndUpdate: (filter, update) => chain((async () => {
      const current = rows.get(filter._id);
      if (!current) return null;
      const next = { ...validated({ ...current, ...update.$set }), createdAt: current.createdAt, updatedAt: new Date() };
      if (duplicate(next)) throw e11000();
      rows.set(next._id, next);
      return structuredClone(next);
    })()),
    deleteOne: async (filter) => ({ deletedCount: rows.delete(filter._id) ? 1 : 0 }),
    async bulkWrite(ops) {
      for (const { updateOne } of ops) {
        const r = rows.get(updateOne.filter._id);
        if (r) Object.assign(r, updateOne.update.$set);
      }
    },
  };
}

/** TrafficRecord / SignalEvent recorder that also answers the latest-record query. */
function fakeRecordModel(Schema) {
  const docs = [];
  return {
    docs,
    async create(doc) {
      if (Schema) {
        const err = new Schema(doc).validateSync();
        if (err) throw err;
      }
      docs.push(doc);
      return doc;
    },
    find(filter) {
      let n = Infinity;
      const q = {
        sort: () => q,
        limit: (k) => { n = k; return q; },
        lean: async () => docs
          .filter((d) => d.dataMode !== 'simulation' && (!filter.intersectionId || d.intersectionId === filter.intersectionId))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, n),
      };
      return q;
    },
  };
}

// ----------------------------------------------------------------- app

/** Mounted like server.js: /api/streams, then /api. */
async function startApp({
  ingestToken = INGEST, adminToken = ADMIN, connected = true, withHistory = false, sampleIntervalMs = 0, now = Date.now,
} = {}) {
  const engine = createTrafficDecisionService({ intersections, config });
  const stateService = createTrafficStateService();
  const db = { connected };
  const Model = fakeStreamModel();
  const streams = createStreamRegistryService({
    TrafficStream: Model, isConnected: () => db.connected, log: { warn() {} }, now,
  });
  const records = fakeRecordModel(TrafficRecord);
  const history = withHistory
    ? createTrafficHistoryService({
      stateService,
      decisionService: engine,
      TrafficRecord: records,
      SignalEvent: fakeRecordModel(),
      isConnected: () => db.connected,
      log: { warn() {} },
      sampleIntervalMs,
    }).start()
    : null;

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/streams', createStreamRoutes(
    createStreamController(streams, { hasIntersection: (id) => engine.has(id), secrets: [ingestToken, adminToken] }),
    { ingestToken, adminToken },
  ));
  app.use('/api', createTrafficRoutes(createTrafficController(engine, {
    stateService, history, ingestToken, streamRegistry: streams,
  })));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'no route' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const request = async (method, path, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const register = (stream) => request('POST', '/streams', { body: stream, token: adminToken });
  const ingest = (overrides = {}, token = ingestToken) => request('POST', '/traffic', {
    body: { ...structuredClone(SAMPLE), source: 'python-ai', timestamp: new Date().toISOString(), ...overrides }, token,
  });
  const close = () => {
    if (history) history.stop();
    return new Promise((r) => server.close(r));
  };
  return { engine, stateService, streams, Model, records, history, db, request, register, ingest, close };
}

const stream = (overrides = {}) => ({
  id: 'main-north-1', name: 'Main St northbound', url: YT, intersectionId: 'main', direction: 'north', priority: 1, ...overrides,
});

// ---------------------------------------------------------------- models

test('TrafficStream model accepts a valid record and rejects invalid ones', () => {
  const ok = new TrafficStream({ _id: 'main-north-1', name: 'n', url: YT, sourceType: 'youtube', intersectionId: 'main', direction: 'north' });
  assert.equal(ok.validateSync(), undefined);
  assert.equal(ok.enabled, true);
  assert.equal(ok.priority, 0);
  assert.equal(ok.status, 'unknown');

  const whole = new TrafficStream({ _id: 'main-all', name: 'n', url: YT, sourceType: 'youtube', intersectionId: 'main', direction: null });
  assert.equal(whole.validateSync(), undefined, 'direction null = whole intersection');

  const bad = [
    { _id: 'bad id!' },
    { sourceType: 'ftp' },
    { direction: 'up' },
    { priority: 1.5 },
    { priority: -1 },
    { status: 'great' },
    { intersectionId: '' },
    { url: '' },
  ];
  for (const change of bad) {
    const m = new TrafficStream({ _id: 's1', name: 'n', url: YT, sourceType: 'youtube', intersectionId: 'main', ...change });
    assert.ok(m.validateSync(), JSON.stringify(change));
  }
});

test('TrafficRecord stores optional stream attribution and validates its ids', () => {
  const base = {
    intersectionId: 'main', dataMode: 'live', timestamp: new Date(), receivedAt: new Date(), source: 'python-ai',
    traffic: SAMPLE.traffic, pedestrians: { north: false, south: false, east: false, west: false },
    emergency: { detected: false, type: null, direction: null, confidence: 0 },
    signal: {
      mode: 'NORMAL', phase: 'GREEN',
      signals: { north: 'GREEN', south: 'RED', east: 'RED', west: 'RED' },
      pedestrianSignals: { north: 'DONT_WALK', south: 'DONT_WALK', east: 'DONT_WALK', west: 'DONT_WALK' },
    },
  };
  assert.equal(new TrafficRecord(base).validateSync(), undefined, 'records without streams stay valid');
  assert.equal(new TrafficRecord(base).toObject().streams, undefined, 'absent attribution is not invented');
  const withStreams = new TrafficRecord({ ...base, streams: { north: 'main-north-1' } });
  assert.equal(withStreams.validateSync(), undefined);
  assert.equal(withStreams.streams.north, 'main-north-1');
  assert.equal(withStreams.streams.south, null);
  assert.ok(new TrafficRecord({ ...base, streams: { north: 'no spaces' } }).validateSync());
});

// ----------------------------------------------------------- validation

test('stream input validation matches the AI service rules and never echoes the URL', () => {
  const known = (id) => id === 'main';
  const ok = validateStreamInput(stream({ priority: undefined, name: undefined }), { hasIntersection: known });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.equal(ok.value.sourceType, 'youtube', 'inferred from the URL');
  assert.equal(ok.value.name, 'main-north-1');
  assert.equal(ok.value.priority, 0);
  assert.equal(ok.value.enabled, true);

  assert.equal(validateStreamInput(stream({ url: 'https://example.com/live/index.m3u8' })).value.sourceType, 'hls');
  assert.equal(validateStreamInput(stream({ url: 'rtsp://cam.local:554/1' })).value.sourceType, 'rtsp');
  assert.equal(validateStreamInput(stream({ url: 'camera:0' })).value.sourceType, 'camera');

  const cases = [
    [stream({ url: 'https://user:secret-pass@example.com/live' }), /must not embed credentials/],
    [stream({ url: 'https://example.com/x', sourceType: 'youtube' }), /not a valid youtube source/],
    [stream({ intersectionId: 'atlantis' }), /not a known intersection/],
    [stream({ direction: 'up' }), /direction must be one of/],
    [stream({ priority: 2.5 }), /priority must be an integer/],
    [stream({ enabled: 'yes' }), /enabled must be a boolean/],
    [stream({ id: 'has space' }), /id must be/],
    [stream({ status: 'online' }), /status is not a stream setting/],
    [{ ...stream(), url: undefined }, /url must be a nonempty string/],
  ];
  for (const [input, pattern] of cases) {
    const r = validateStreamInput(input, { hasIntersection: known });
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.match(r.errors.join(' | '), pattern);
    assert.doesNotMatch(r.errors.join(' | '), /secret-pass|private-yt-token/);
  }

  const patch = validateStreamInput({ priority: 3, enabled: false }, { partial: true });
  assert.deepEqual(patch.value, { priority: 3, enabled: false });
  assert.match(validateStreamInput({ id: 'x' }, { partial: true }).errors.join(), /id cannot be changed/);
  assert.match(validateStreamInput({}, { partial: true }).errors.join(), /Nothing to update/);
  assert.match(validateStreamInput({ sourceType: 'hls' }, { partial: true }).errors.join(), /only be changed together with url/);
});

test('error text from health reports is sanitized', () => {
  assert.equal(sanitizeError(null), null);
  const s = sanitizeError('open failed: https://cdn.example.com/x.m3u8?sig=abc token=s3cr3t\nline2 MYSECRET', ['MYSECRET']);
  assert.doesNotMatch(s, /cdn\.example|abc|s3cr3t|MYSECRET|\n/);
  assert.match(s, /<url>/);
  assert.ok(sanitizeError('x'.repeat(500)).length <= 200);
});

// ---------------------------------------------------- registration / auth

test('streams can be registered, read, updated and removed by the admin', async () => {
  const app = await startApp();
  try {
    const created = await app.register(stream());
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.stream.id, 'main-north-1');
    assert.equal(created.body.stream.sourceType, 'youtube');
    assert.equal(created.body.stream.status, 'unknown');
    assert.ok(created.body.stream.createdAt);
    assert.equal(app.Model.rows.size, 1);

    // The AI service (ingest token) reads the full record, URL included.
    const list = await app.request('GET', '/streams', { token: INGEST });
    assert.equal(list.status, 200);
    assert.equal(list.body.streams[0].url, YT);
    const one = await app.request('GET', '/streams/main-north-1', { token: INGEST });
    assert.equal(one.body.stream.name, 'Main St northbound');

    assert.equal((await app.register(stream())).status, 409, 'same id twice');
    assert.equal((await app.register(stream({ id: 'main-north-2' }))).status, 409, 'same URL for the same slot');
    assert.equal((await app.register(stream({ id: 'main-south-1', direction: 'south' }))).status, 201, 'same URL, other slot');

    const patched = await app.request('PATCH', '/streams/main-north-1', { body: { priority: 5, name: 'Renamed' }, token: ADMIN });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.stream.priority, 5);
    assert.equal(patched.body.stream.name, 'Renamed');
    assert.equal(patched.body.stream.url, YT, 'unchanged fields kept');
    assert.equal((await app.request('PATCH', '/streams/main-north-1', { body: { status: 'online' }, token: ADMIN })).status, 400,
      'health fields cannot be set through configuration');
    assert.equal((await app.request('PATCH', '/streams/nope', { body: { priority: 1 }, token: ADMIN })).status, 404);

    assert.equal((await app.request('DELETE', '/streams/main-north-1', { token: ADMIN })).status, 200);
    assert.equal((await app.request('DELETE', '/streams/main-north-1', { token: ADMIN })).status, 404);
    assert.equal((await app.request('GET', '/streams/main-north-1', { token: INGEST })).status, 404);
  } finally { await app.close(); }
});

test('disabled streams are excluded from the active list; order is by priority', async () => {
  const app = await startApp();
  try {
    await app.register(stream({ id: 'n-backup', url: 'https://example.com/b.m3u8', priority: 2 }));
    await app.register(stream({ id: 'n-main', priority: 1 }));
    await app.register(stream({ id: 'n-off', url: 'https://example.com/c.m3u8', priority: 0 }));
    await app.register(stream({ id: 'west-1', url: 'https://example.com/w.m3u8', intersectionId: 'market-square', direction: 'west' }));
    await app.request('PATCH', '/streams/n-off', { body: { enabled: false }, token: ADMIN });

    const active = await app.request('GET', '/streams?enabled=true', { token: INGEST });
    assert.deepEqual(active.body.streams.map((s) => s.id), ['n-main', 'n-backup', 'west-1']);
    assert.ok(active.body.streams.every((s) => s.enabled));
    const disabled = await app.request('GET', '/streams?enabled=false', { token: INGEST });
    assert.deepEqual(disabled.body.streams.map((s) => s.id), ['n-off']);
    const one = await app.request('GET', '/streams?enabled=true&intersectionId=market-square', { token: INGEST });
    assert.deepEqual(one.body.streams.map((s) => s.id), ['west-1']);
    assert.equal((await app.request('GET', '/streams?enabled=maybe', { token: INGEST })).status, 400);
  } finally { await app.close(); }
});

test('stream endpoints require the right token; the public status never shows URLs or tokens', async () => {
  const app = await startApp();
  try {
    for (const token of [undefined, 'wrong', INGEST]) {
      const res = await app.request('POST', '/streams', { body: stream(), token });
      assert.equal(res.status, 401, `create with ${token}`);
      assert.doesNotMatch(res.text, new RegExp(`${INGEST}|${ADMIN}`));
    }
    assert.equal((await app.request('DELETE', '/streams/x', { token: INGEST })).status, 401, 'the AI token cannot delete');
    await app.register(stream());

    assert.equal((await app.request('GET', '/streams')).status, 401, 'stream URLs are not public');
    assert.equal((await app.request('GET', '/streams', { token: 'wrong' })).status, 401);
    assert.equal((await app.request('GET', '/streams', { token: ADMIN })).status, 200, 'the admin may read too');
    assert.equal((await app.request('POST', '/streams/health', { body: { streams: [] } })).status, 401);

    const status = await app.request('GET', '/streams/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.available, true);
    assert.equal(status.body.streams[0].host, 'www.youtube.com');
    assert.equal(status.body.streams[0].url, undefined);
    assert.doesNotMatch(status.text, /private-yt-token|watch\?v=|test-ingest|test-admin/);
  } finally { await app.close(); }

  const noAdmin = await startApp({ adminToken: '' });
  try {
    const res = await noAdmin.request('POST', '/streams', { body: stream(), token: INGEST });
    assert.equal(res.status, 503, 'management is disabled without STREAM_ADMIN_TOKEN');
    assert.match(res.body.error, /STREAM_ADMIN_TOKEN/);
  } finally { await noAdmin.close(); }

  const open = await startApp({ ingestToken: '' });
  try {
    assert.equal((await open.request('GET', '/streams')).status, 200, 'no ingest token configured: same open rule as POST /api/traffic');
  } finally { await open.close(); }
});

test('without a database the registry answers 503 and the status says unavailable', async () => {
  const app = await startApp({ connected: false });
  try {
    assert.equal((await app.request('GET', '/streams', { token: INGEST })).status, 503);
    assert.equal((await app.register(stream())).status, 503);
    const status = await app.request('GET', '/streams/status');
    assert.equal(status.body.available, false);
    assert.deepEqual(status.body.streams, []);
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ health

test('health reports update known streams only, sanitized, and go stale', async () => {
  let t = Date.parse('2026-10-09T12:00:00Z');
  const app = await startApp({ now: () => t });
  const changes = [];
  app.streams.on('change', (s) => changes.push(s));
  try {
    await app.register(stream());
    await app.register(stream({ id: 'other-1', url: 'https://example.com/o.m3u8', intersectionId: 'market-square' }));
    changes.length = 0;

    const report = {
      source: 'python-ai',
      reportedAt: new Date(t).toISOString(),
      intersectionId: 'main',
      streams: [
        { id: 'main-north-1', state: 'degraded', active: true, lastFrameAt: '2026-10-09T11:59:58Z', lastInferenceAt: null, consecutiveFailures: 2, error: `read timeout ${YT}` },
        { id: 'not-registered', state: 'online' },
        { id: 'other-1', state: 'offline' },
        { id: 'main-north-1', state: 'brilliant' },
      ],
      coverage: { north: { streamId: 'main-north-1', state: 'online' } },
    };
    const res = await app.request('POST', '/streams/health', { body: report, token: INGEST });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.updated, 1);
    assert.deepEqual(res.body.ignored.map((i) => i.id), ['not-registered', 'other-1'], 'unknown and foreign ids are ignored');
    assert.equal(res.body.rejected.length, 1);
    assert.equal(res.body.rejected[0].index, 3);
    assert.equal(res.body.persisted, true);

    const stored = app.Model.rows.get('main-north-1');
    assert.equal(stored.status, 'degraded');
    assert.equal(stored.consecutiveFailures, 2);
    assert.equal(stored.lastFrameAt.toISOString(), '2026-10-09T11:59:58.000Z');
    assert.doesNotMatch(stored.lastError, /youtube|private-yt-token/, 'stream URL never stored in the error');
    assert.equal(app.Model.rows.get('other-1').status, 'unknown', 'other intersection untouched');
    assert.equal(changes.length, 1, 'one change event for the dashboard');

    let status = (await app.request('GET', '/streams/status')).body.streams.find((s) => s.id === 'main-north-1');
    assert.equal(status.status, 'degraded');
    assert.equal(status.stale, false);
    t += 61_000; // no report for longer than staleAfterSeconds
    status = (await app.request('GET', '/streams/status')).body.streams.find((s) => s.id === 'main-north-1');
    assert.equal(status.stale, true);

    // Going offline keeps the last successful frame time.
    await app.request('POST', '/streams/health', { body: { streams: [{ id: 'main-north-1', state: 'offline', lastFrameAt: null }] }, token: INGEST });
    assert.equal(app.Model.rows.get('main-north-1').status, 'offline');
    assert.equal(app.Model.rows.get('main-north-1').lastFrameAt.toISOString(), '2026-10-09T11:59:58.000Z');

    assert.equal((await app.request('POST', '/streams/health', { body: { streams: 'x' }, token: INGEST })).status, 400);
  } finally { await app.close(); }
});

// -------------------------------------------------------------- ingestion

test('authenticated ingestion with stream attribution updates the latest state', async () => {
  const app = await startApp();
  try {
    await app.register(stream());
    await app.register(stream({ id: 'main-overhead', url: 'https://example.com/top.m3u8', direction: null }));
    await app.register(stream({ id: 'main-old', url: 'https://example.com/old.m3u8', direction: 'east' }));
    await app.request('PATCH', '/streams/main-old', { body: { enabled: false }, token: ADMIN });

    assert.equal((await app.ingest({}, null)).status, 401, 'no token');
    assert.equal((await app.ingest({}, 'wrong')).status, 401);

    const ok = await app.ingest({ streams: { north: 'main-north-1', south: 'main-overhead', west: null } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.warnings, undefined);
    const latest = await app.request('GET', '/traffic/observations/main');
    assert.equal(latest.body.from, 'memory');
    assert.deepEqual(latest.body.observation.streams, { north: 'main-north-1', south: 'main-overhead' });
    assert.equal(latest.body.observation.source, 'python-ai');
    assert.equal(app.engine.getSnapshot('main').aiStatus, 'CONNECTED');

    const disabled = await app.ingest({ streams: { east: 'main-old' } });
    assert.equal(disabled.status, 200, 'a just-disabled stream is not misattribution');
    assert.match(disabled.body.warnings.join(), /disabled/);

    const legacy = await app.ingest();
    assert.equal(legacy.status, 200, 'payloads without `streams` are unchanged');
  } finally { await app.close(); }
});

test('misattributed or malformed observations are rejected and change nothing', async () => {
  const app = await startApp();
  try {
    await app.register(stream());
    await app.register(stream({ id: 'market-west', url: 'https://example.com/w.m3u8', intersectionId: 'market-square', direction: 'west' }));

    const cases = [
      [{ streams: { west: 'market-west' } }, 422, /belongs to intersection "market-square"/],
      [{ streams: { south: 'main-north-1' } }, 422, /covers the north approach, not south/],
      [{ streams: { north: 'ghost' } }, 422, /unknown stream "ghost"/],
      [{ streams: { up: 'main-north-1' } }, 400, /streams\.up is not a valid direction/],
      [{ streams: ['main-north-1'] }, 400, /streams must be an object/],
      [{ streams: { north: 'bad id' } }, 400, /streams\.north must be a stream id/],
      [{ intersectionId: 'market-square', streams: { north: 'main-north-1' } }, 422, /belongs to intersection "main"/],
    ];
    for (const [overrides, status, pattern] of cases) {
      const res = await app.ingest(overrides);
      assert.equal(res.status, status, JSON.stringify(overrides));
      assert.match((res.body.details || []).join(' | '), pattern);
    }
    assert.equal(app.stateService.getAllTrafficStates().length, 0, 'nothing was stored');
    assert.equal(app.engine.getSnapshot('main').updatesReceived, 0, 'the decision engine saw nothing');
  } finally { await app.close(); }
});

test('when the registry is unavailable, attribution is accepted unverified and not recorded', async () => {
  const app = await startApp({ connected: false });
  try {
    const res = await app.ingest({ streams: { north: 'main-north-1' } });
    assert.equal(res.status, 200, 'signal control does not depend on the database');
    assert.match(res.body.warnings.join(), /not verified/);
    assert.equal(app.stateService.getTrafficState('main').streams, null);
  } finally { await app.close(); }
});

// ------------------------------------------------------------- persistence

test('observations are persisted with their streams, sampled per intersection', async () => {
  const app = await startApp({ withHistory: true, sampleIntervalMs: 5000 });
  try {
    await app.register(stream());
    const t0 = Date.now() - 60_000;
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    for (let s = 0; s < 12; s += 1) {
      const res = await app.ingest({ timestamp: at(s), streams: { north: 'main-north-1' } });
      assert.equal(res.status, 200, res.text);
    }
    await app.history.flush();
    // 12 observations at 1 Hz, one record per 5 s of capture time.
    assert.deepEqual(app.records.docs.map((d) => d.timestamp.toISOString()), [at(0), at(5), at(10)]);
    assert.deepEqual(app.records.docs[0].streams, { north: 'main-north-1' });
    assert.equal(app.history.stats().sampledOut, 9);

    // A detected emergency is stored at once, inside the sampling interval.
    await app.ingest({ timestamp: at(11.5), emergency: { detected: true, type: 'ambulance', direction: 'west', confidence: 0.9 } });
    await app.history.flush();
    assert.equal(app.records.docs.length, 4);
    assert.equal(app.records.docs[3].emergency.detected, true);
    assert.equal(app.records.docs[3].streams, undefined, 'no attribution sent, none stored');
  } finally { await app.close(); }
});

test('latest state falls back to the newest stored record after a restart', async () => {
  const app = await startApp({ withHistory: true });
  try {
    assert.equal((await app.request('GET', '/traffic/observations/main')).status, 404, 'nothing anywhere yet');
    const sent = await app.ingest({ timestamp: new Date(Date.now() - 30_000).toISOString() });
    assert.equal(sent.status, 200);
    await app.history.flush();
    app.stateService.clear(); // what a restart loses: the in-memory latest state

    const res = await app.request('GET', '/traffic/observations/main');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.from, 'database');
    assert.deepEqual(res.body.observation.traffic, SAMPLE.traffic);
    assert.ok(res.body.ageSeconds >= 0);
    assert.equal(app.engine.getSnapshot('main').updatesReceived, 1, 'stored history is not replayed into the engine');

    app.db.connected = false;
    assert.equal((await app.request('GET', '/traffic/observations/main')).status, 404, 'database down: no data, no error');
  } finally { await app.close(); }
});

// ------------------------------------------------------------------ socket

test('stream status is broadcast to the live room only, without URLs', async () => {
  const sent = [];
  const io = { on() {}, to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }) };
  const engine = createTrafficDecisionService({ intersections, config });
  const streams = createStreamRegistryService({ TrafficStream: fakeStreamModel(), isConnected: () => true, log: { warn() {} } });
  bindTrafficEvents(io, engine, { streams });

  await streams.create({ id: 'main-north-1', name: 'n', url: YT, sourceType: 'youtube', intersectionId: 'main', direction: 'north', enabled: true, priority: 0 });
  const events = sent.filter((s) => s.event === 'streamStatus');
  assert.equal(events.length, 1);
  assert.equal(events[0].room, 'live');
  assert.equal(events[0].payload.streams[0].id, 'main-north-1');
  assert.doesNotMatch(JSON.stringify(events[0].payload), /private-yt-token|watch\?v=/);
  // Existing events keep their names.
  engine.ingest({ ...structuredClone(SAMPLE), traffic: Object.fromEntries(Object.entries(SAMPLE.traffic).map(([d, v]) => [d, { ...v, waiting: v.waitingTime }])) });
  assert.ok(sent.some((s) => s.event === 'trafficUpdate' && s.room === 'live'));
});
