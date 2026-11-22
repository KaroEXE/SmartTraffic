// GET /api/search and GET /api/geocode/reverse over HTTP: the real router, controller, validation and
// service, with the repository replaced by a stand-in that returns rows in the database's shape.
// What the SQL returns for real OpenStreetMap data is tested in test/geoDatabase.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const baseConfig = require('../config');
const { createPostgres, sslOption } = require('../db/postgres');
const { createGeoService } = require('../services/geo/geoService');
const { fakeGeoRepository } = require('./helpers/navigationHarness');
const spec = require('../docs/openapi');

const rateLimits = { ...baseConfig.navigation.rateLimits, searchPerMinute: 10_000 };
const configWith = (overrides = {}) => ({
  ...baseConfig,
  postgres: { ...baseConfig.postgres, url: 'postgresql://unused', ...overrides.postgres },
  navigation: { ...baseConfig.navigation, rateLimits: { ...rateLimits, ...overrides.rateLimits } },
});

const entity = (overrides = {}) => ({
  place_key: 'osm:n1', source: 'osm', entity: 'poi', osm_type: 'n', osm_id: 1, name: 'A', names: { name: 'A' }, category: 'cafe', type: 'cafe',
  lat: 35.5, lng: 45.4, bbox: null, address: null, address_text: null, city: null, state: null, details: {}, importance: 0.3, verified: false, rating: null, rating_count: 0, distance_m: null,
  ...overrides,
});

/** The geo router mounted at /api in front of the same 404 the real server has. */
async function start({ repository = fakeGeoRepository(), enabled = true, config = configWith() } = {}) {
  const service = createGeoService({ repository, enabled });
  const { createGeoController } = require('../controllers/geoController');
  const { createGeoRoutes } = require('../routes/geoRoutes');
  const router = createGeoRoutes({ controller: createGeoController({ geo: service }), rateLimits: config.navigation.rateLimits });
  const app = express();
  app.use('/api', router);
  app.use('/api', (req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => { server.once('listening', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, headers = {}) => {
    const res = await fetch(origin + p, { headers });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return {
    get, repository, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

test('GET /api/search: the clean response structure, not raw rows', async () => {
  const repository = fakeGeoRepository({
    searchPlaces: async (args) => {
      repository.calls.push({ name: 'searchPlaces', args });
      return { normalized: 'family mall', rows: [entity({ place_key: 'osm:w5', category: 'shopping_mall', type: 'mall', name: 'Family Mall', names: { name: 'Family Mall', 'name:ar': 'فاميلي مول' }, distance_m: 480.2 })] };
    },
  });
  const t = await start({ repository });
  try {
    const r = await t.get('/api/search?q=Family%20Mall&lat=35.56&lng=45.43&limit=5');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.query, 'Family Mall');
    assert.equal(r.body.count, 1);
    const [place] = r.body.results;
    assert.deepEqual(Object.keys(place).sort(), ['address', 'addressDetails', 'boundingBox', 'category', 'distanceMeters', 'entity', 'id', 'latitude', 'longitude', 'name', 'names', 'source', 'type', 'verified'], 'only documented fields');
    assert.equal(place.type, 'shopping_mall');
    assert.equal(place.source, 'osm');
    assert.equal(place.distanceMeters, 480);
    assert.equal(place.names.ar, 'فاميلي مول');
    assert.deepEqual(r.body.pagination, {
      limit: 5, offset: 0, count: 1, hasMore: false,
    });
    assert.equal(r.body.attribution.provider, 'OpenStreetMap');
    const call = repository.calls.find((c) => c.name === 'searchPlaces');
    assert.deepEqual(call.args, {
      query: 'Family Mall', near: { lat: 35.56, lng: 45.43 }, limit: 6, offset: 0,
    });
    assert.equal((await t.get('/api/search?q=Family')).body.results[0].distanceMeters, 480, 'the stand-in ignores the position: the service only formats');
  } finally { await t.close(); }
});

test('GET /api/search pages with limit and offset, and says when there is more', async () => {
  const rows = Array.from({ length: 4 }, (_, i) => entity({ place_key: `osm:n${i}` }));
  const t = await start({ repository: fakeGeoRepository({ searchPlaces: async ({ limit }) => ({ normalized: 'a', rows: rows.slice(0, limit) }) }) });
  try {
    const page = await t.get('/api/search?q=caf&limit=3&offset=3');
    assert.equal(page.body.count, 3);
    assert.deepEqual(page.body.pagination, {
      limit: 3, offset: 3, count: 3, hasMore: true,
    });
    const last = await t.get('/api/search?q=caf&limit=10');
    assert.equal(last.body.pagination.hasMore, false);
    assert.equal(last.body.count, 4);
  } finally { await t.close(); }
});

test('GET /api/search validates its input and answers an empty or unknown search honestly', async () => {
  const t = await start();
  try {
    for (const bad of ['/api/search', '/api/search?q=', '/api/search?q=a', '/api/search?q=%20%20', `/api/search?q=${'x'.repeat(201)}`,
      '/api/search?q=cafe&lat=35', '/api/search?q=cafe&lat=95&lng=45', '/api/search?q=cafe&lat=abc&lng=45', '/api/search?q=cafe&limit=0', '/api/search?q=cafe&limit=21',
      '/api/search?q=cafe&offset=-1', '/api/search?q=cafe&offset=201', '/api/search?q=cafe&lang=not%20a%20tag']) {
      const r = await t.get(bad);
      assert.equal(r.status, 400, bad);
      assert.equal(r.body.code, 'INVALID_REQUEST', bad);
      assert.equal(r.body.ok, false);
      assert.ok(r.body.details.length, bad);
    }
    const none = await t.get('/api/search?q=zzzz%20no%20such%20place');
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.results, []);
    assert.equal(none.body.count, 0);
    // Text that is SQL or a wildcard is only text: it is passed on as a bound value.
    const odd = await t.get(`/api/search?q=${encodeURIComponent("100% ' ; DROP TABLE search_names; --")}`);
    assert.equal(odd.status, 200);
    assert.equal((await t.get('/api/search?q=cafe', { 'Accept-Language': 'ar-IQ,ar;q=0.9' })).status, 200);
  } finally { await t.close(); }
});

test('GET /api/geocode/reverse: street, area, city, country and the place right there', async () => {
  const area = (admin_level, name) => ({ osm_id: admin_level, admin_level, name, names: { name, 'name:en': name } });
  const repository = fakeGeoRepository({
    findNearestRoad: async () => ({ osm_id: 7, name: 'Some Road', names: { name: 'Some Road' }, highway: 'tertiary', oneway: 'yes', maxspeed: '50', distance_m: 8.4 }),
    findAdminAreasAt: async () => [area(6, 'Some District'), area(8, 'Some City'), area(4, 'Some Governorate'), area(2, 'Some Country')],
    findNearestPoi: async () => ({ place_key: 'osm:n3', name: 'Some Shop', names: { name: 'Some Shop' }, category: 'shop', distance_m: 20 }),
    findNearestAddress: async () => ({ street: 'Some Road', housenumber: '12', distance_m: 5 }),
  });
  const t = await start({ repository });
  try {
    const r = await t.get('/api/geocode/reverse?lat=35.56&lng=45.43');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.latitude, 35.56);
    assert.equal(r.body.longitude, 45.43);
    assert.equal(r.body.street, 'Some Road');
    assert.equal(r.body.houseNumber, '12');
    assert.equal(r.body.district, 'Some District');
    assert.equal(r.body.city, 'Some City');
    assert.equal(r.body.state, 'Some Governorate');
    assert.equal(r.body.country, 'Some Country');
    assert.equal(r.body.displayName, 'Some Road 12, Some City, Some Governorate, Some Country');
    assert.deepEqual(r.body.nearestRoad, {
      id: 'osm:w7', osmWayId: 7, name: 'Some Road', type: 'tertiary', ref: null, oneway: 'yes', maxspeed: '50', lanes: null, surface: null, access: null, junction: null, bridge: null, tunnel: null, distanceMeters: 8,
    });
    assert.deepEqual(r.body.place, {
      id: 'osm:n3', name: 'Some Shop', type: 'shop', distanceMeters: 20,
    });
  } finally { await t.close(); }

  const empty = await start();
  try {
    const r = await empty.get('/api/geocode/reverse?lat=1.5&lng=1.5');
    assert.equal(r.status, 200);
    assert.equal(r.body.displayName, null, 'nothing known there: null, never an invented address');
    assert.equal(r.body.street, null);
    assert.equal(r.body.nearestRoad, null);
    for (const bad of ['', '?lat=35', '?lng=45', '?lat=95&lng=45', '?lat=35&lng=181', '?lat=x&lng=y']) {
      const b = await empty.get(`/api/geocode/reverse${bad}`);
      assert.equal(b.status, 400, bad);
      assert.equal(b.body.code, 'INVALID_REQUEST');
    }
  } finally { await empty.close(); }
});

test('the geographic endpoints answer 503 FEATURE_DISABLED without DATABASE_URL, and the rest of /api is untouched', async () => {
  const t = await start({ enabled: false });
  try {
    for (const url of ['/api/search?q=cafe', '/api/geocode/reverse?lat=35&lng=45']) {
      const r = await t.get(url);
      assert.equal(r.status, 503, url);
      assert.equal(r.body.code, 'FEATURE_DISABLED');
    }
    assert.equal((await t.get('/api/search?q=a')).status, 400, 'input is still validated first');
    assert.equal((await t.get('/api/other')).status, 404, 'other /api paths fall through to the server\'s own 404');
  } finally { await t.close(); }
});

test('database errors become stable, non-leaky answers', async () => {
  const mapped = async (code, message = 'x') => {
    const pool = {
      on() {}, query: async () => { const e = new Error(message); e.code = code; throw e; }, end: async () => {},
    };
    const pg = createPostgres({ config: { url: 'postgresql://u:secret@h/d', ssl: 'false', poolMax: 1, statementTimeoutMs: 1000 }, log: { warn() {} }, PoolImpl: function Pool() { return pool; } });
    try { await pg.query('SELECT 1'); } catch (e) { return e; }
    return null;
  };
  assert.deepEqual([(await mapped('ECONNREFUSED')).status, (await mapped('ECONNREFUSED')).code], [503, 'GEO_DATABASE_UNAVAILABLE']);
  assert.equal((await mapped('57014')).code, 'GEO_QUERY_TIMEOUT');
  assert.equal((await mapped('42P01')).code, 'GEO_DATA_NOT_READY');
  const other = await mapped('22P02', 'invalid input syntax for password=secret');
  assert.equal(other.status, undefined, 'an SQL mistake is not dressed up: it reaches the server error handler (500, logged)');
  const none = createPostgres({ config: { url: '', ssl: 'false', poolMax: 1, statementTimeoutMs: 1000 } });
  assert.equal(none.enabled, false);
  await assert.rejects(none.query('SELECT 1'), (e) => e.code === 'FEATURE_DISABLED');
  assert.deepEqual(await none.ping(), { enabled: false, connected: false });
  assert.deepEqual(sslOption('false'), false);
  assert.deepEqual(sslOption('true'), { rejectUnauthorized: true });
  assert.deepEqual(sslOption('no-verify'), { rejectUnauthorized: false });
});

test('the search endpoints are rate limited per client', async () => {
  const t = await start({ config: configWith({ rateLimits: { searchPerMinute: 2 } }) });
  try {
    assert.equal((await t.get('/api/search?q=cafe')).status, 200);
    assert.equal((await t.get('/api/geocode/reverse?lat=35&lng=45')).status, 200);
    const limited = await t.get('/api/search?q=cafe');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.ok(limited.headers.get('retry-after'));
  } finally { await t.close(); }
});

test('Swagger documents exactly the routes of the geographic router', () => {
  const { createGeoRoutes } = require('../routes/geoRoutes');
  const handler = () => {};
  const router = createGeoRoutes({ controller: { search: handler, reverse: handler }, rateLimits });
  const routed = new Set();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) if (method !== '_all') routed.add(`${method} /api${layer.route.path}`);
  }
  const documented = Object.entries(spec.paths).filter(([p]) => /^\/api\/(search|geocode)/.test(p))
    .flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m} ${p}`));
  assert.deepEqual([...routed].sort(), documented.sort());
  for (const p of ['/api/search', '/api/geocode/reverse']) {
    const op = spec.paths[p].get;
    assert.ok(op.responses[200] && op.responses[400] && op.responses[429] && op.responses[503], `${p} documents success and errors`);
    assert.ok(op.parameters.some((x) => x.name === 'lat') && op.parameters.some((x) => x.name === 'lng'));
    assert.ok(op.responses[200].content['application/json'].examples, `${p} has an example`);
  }
  assert.ok(spec.paths['/api/search'].get.parameters.some((x) => x.name === 'offset'), 'paging is documented');
});

test('search never leaves this server: the geographic code has no external provider in it', () => {
  const root = path.join(__dirname, '..');
  const files = ['services/geo/geoService.js', 'services/geo/index.js', 'repositories/geoRepository.js', 'controllers/geoController.js', 'routes/geoRoutes.js',
    'db/postgres.js', 'services/navigation/placeService.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bfetch\s*\(|require\(['"](?:https?|node-fetch|axios|got)['"]\)|geoapify|google|mapbox|nominatim|photon/i, `${f} must not call an external provider`);
  }
});
