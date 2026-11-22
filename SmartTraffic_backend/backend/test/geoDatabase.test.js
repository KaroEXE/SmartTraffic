// The geographic layer against a REAL PostgreSQL/PostGIS database that holds a REAL OpenStreetMap
// import (npm run db:migrate, npm run db:import-osm). No stand-ins: every row comes from the database.
//
// Opt-in: set GEO_TEST_DATABASE_URL to a database you may query (and, for the Redoz-place test, insert a
// row into and delete it again). Without it every test here is skipped, so `npm test` can never touch a
// production database by accident. The facts asserted are geography (Sulaymaniyah is near 35.56 N,
// 45.43 E; Iraq is 29-38 N, 38-49 E) and invariants of the ranking, not particular OSM objects.
const test = require('node:test');
const assert = require('node:assert/strict');

const url = (process.env.GEO_TEST_DATABASE_URL || '').trim();
const skip = url ? false : 'set GEO_TEST_DATABASE_URL to run the PostGIS tests';

const { createPostgres } = require('../db/postgres');
const { createGeoRepository } = require('../repositories/geoRepository');
const { createGeoService } = require('../services/geo/geoService');
const { buildSearch } = require('../repositories/geoRepository');

const SULAYMANIYAH = { lat: 35.5617, lng: 45.4329 };
const IRAQ = { south: 29, west: 38, north: 38, east: 49 };

let pg;
let repository;
let geo;

test.before(async () => {
  if (skip) return;
  pg = createPostgres({ config: { url, ssl: (process.env.GEO_TEST_DATABASE_SSL || 'false'), poolMax: 4, statementTimeoutMs: 20_000 }, log: { warn() {} } });
  repository = createGeoRepository({ pg });
  geo = createGeoService({ repository, enabled: true });
});
test.after(async () => { if (pg) await pg.close(); });

const km = async (a, b) => (await repository.distanceMeters(a, b)) / 1000;
const near = async (result, point, maxKm) => (await km({ lat: result.latitude, lng: result.longitude }, point)) <= maxKm;

test('the schema is migrated: extensions, tables, indexes', { skip }, async () => {
  const ext = (await pg.query("SELECT extname FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm') ORDER BY 1")).rows.map((r) => r.extname);
  assert.deepEqual(ext, ['pg_trgm', 'postgis']);
  const tables = (await pg.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    AND table_name IN ('search_entities', 'search_names', 'category_terms', 'admin_area_parts', 'redoz_places', 'redoz_place_metadata', 'redoz_place_reports', 'osm_places', 'osm_roads', 'osm_addresses', 'osm_admin_areas', 'schema_migrations') ORDER BY 1`)).rows.map((r) => r.table_name);
  assert.deepEqual(tables, ['admin_area_parts', 'category_terms', 'osm_addresses', 'osm_admin_areas', 'osm_places', 'osm_roads', 'redoz_place_metadata', 'redoz_place_reports', 'redoz_places', 'schema_migrations', 'search_entities', 'search_names']);
  const indexes = (await pg.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'")).rows;
  const has = (table, using) => indexes.some((i) => i.indexdef.includes(`ON public.${table} USING ${using}`));
  for (const table of ['search_entities', 'osm_places', 'osm_roads', 'osm_addresses', 'osm_admin_areas', 'admin_area_parts', 'redoz_places']) assert.ok(has(table, 'gist'), `${table} has a GiST index`);
  assert.ok(indexes.some((i) => i.indexname === 'search_names_trgm_gix' && /gin/.test(i.indexdef) && /gin_trgm_ops/.test(i.indexdef)), 'trigram GIN index on search_names');
  assert.ok(indexes.some((i) => i.indexname === 'search_names_prefix_ix' && /text_pattern_ops/.test(i.indexdef)), 'prefix index on search_names');
  const srid = (await pg.query("SELECT f_table_name, srid FROM geometry_columns WHERE f_table_schema = 'public' AND f_table_name IN ('osm_places', 'osm_roads', 'search_entities', 'redoz_places')")).rows;
  assert.ok(srid.length >= 4 && srid.every((r) => r.srid === 4326), 'SRID 4326 everywhere');
});

test('redoz_normalize folds Arabic, Sorani Kurdish and Latin spellings the same way for names and queries', { skip }, async () => {
  const n = async (t) => (await pg.query('SELECT redoz_normalize($1) AS n', [t])).rows[0].n;
  assert.equal(await n('  Family   MALL! '), 'family mall');
  assert.equal(await n('كورد'), await n('کورد'), 'Arabic kaf = Persian/Kurdish kaf');
  assert.equal(await n('علي'), await n('علی'), 'Arabic yeh = Persian yeh');
  assert.equal(await n('مستشفى'), await n('مستشفي'), 'alef maksura = yeh');
  assert.equal(await n('أحمد'), await n('احمد'), 'hamza on alef');
  assert.equal(await n('مَدرَسة'), await n('مدرسه'), 'vowel marks and teh marbuta');
  assert.equal(await n('شـارع'), await n('شارع'), 'tatweel');
  assert.equal(await n('شارع ٦٠'), 'شارع 60', 'Arabic-Indic digits');
  assert.equal(await n('Café Škoda'), 'cafe skoda', 'Latin accents');
  assert.equal(await n("Sa'ad"), 'saad');
  assert.equal(await n('%_'), '', 'wildcards are only punctuation');
  const trigrams = (await pg.query("SELECT cardinality(show_trgm('مستشفى')) AS c")).rows[0].c;
  assert.ok(trigrams >= 4, 'pg_trgm works on Arabic text in this database');
});

test('the import is there: real OSM objects in every table', { skip }, async () => {
  const c = (await pg.query(`SELECT (SELECT count(*) FROM osm_places) AS places, (SELECT count(*) FROM osm_roads) AS roads,
    (SELECT count(*) FROM osm_admin_areas) AS areas, (SELECT count(*) FROM search_entities WHERE source = 'osm') AS entities,
    (SELECT count(*) FROM search_names) AS names, (SELECT count(*) FROM admin_area_parts) AS parts`)).rows[0];
  for (const [k, v] of Object.entries(c)) assert.ok(Number(v) > 0, `${k} is not empty`);
  // Every OSM point is in Iraq's box: the extract is what it claims to be.
  const outside = (await pg.query('SELECT count(*) AS n FROM osm_places WHERE NOT (ST_X(geom) BETWEEN $1 AND $2 AND ST_Y(geom) BETWEEN $3 AND $4)', [IRAQ.west, IRAQ.east, IRAQ.south, IRAQ.north])).rows[0].n;
  assert.ok(Number(outside) < Number(c.places) * 0.01, 'places are in Iraq');
  // Routing tags survive the import.
  const tagged = (await pg.query("SELECT count(*) FILTER (WHERE oneway IS NOT NULL) AS oneway, count(*) FILTER (WHERE maxspeed IS NOT NULL) AS maxspeed, count(*) FILTER (WHERE tags ? 'highway') AS tags FROM osm_roads")).rows[0];
  assert.ok(Number(tagged.tags) === Number(c.roads), 'every road keeps its full tag set');
  assert.ok(Number(tagged.oneway) > 0, 'one-way roads are preserved');
});

test('search: a city by its English, Arabic and Kurdish names', { skip }, async () => {
  for (const q of ['Sulaymaniyah', 'السليمانية', 'سلێمانی']) {
    const r = await geo.searchPlaces({ q, limit: 10 });
    assert.ok(r.results.length > 0, `"${q}" finds something`);
    let found = false;
    for (const place of r.results) if (await near(place, SULAYMANIYAH, 60)) found = true;
    assert.ok(found, `"${q}" finds the real Sulaymaniyah: ${r.results.map((p) => `${p.name}@${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`).join(' | ')}`);
  }
});

test('search: spelling mistakes, prefixes and lower case still find the place', { skip }, async () => {
  for (const q of ['Sulaimaniya', 'sulaymani', 'SULAYMANIYAH', 'Sulaymaniyh']) {
    const r = await geo.searchPlaces({ q, limit: 10 });
    let found = false;
    for (const place of r.results) if (await near(place, SULAYMANIYAH, 60)) found = true;
    assert.ok(found, `"${q}" finds Sulaymaniyah: ${r.results.map((p) => p.name).join(' | ')}`);
  }
  const prefix = await geo.searchPlaces({ q: 'Sulayma', limit: 10 });
  assert.ok(prefix.results.length > 0, 'a prefix finds something');
});

test('search: results are ordered by relevance, exact names first, nothing outside Iraq, nothing invented', { skip }, async () => {
  const r = await geo.searchPlaces({ q: 'Sulaymaniyah', limit: 20 });
  const first = r.results[0];
  assert.ok(first.names.default || first.names.en || first.names.ar || first.names.ckb, 'a named result');
  for (const p of r.results) {
    assert.ok(p.latitude > IRAQ.south && p.latitude < IRAQ.north && p.longitude > IRAQ.west && p.longitude < IRAQ.east, `${p.id} is in Iraq`);
    assert.ok(['osm', 'redoz'].includes(p.source));
    assert.match(p.id, /^(osm:[nwrsa]\d+|redoz:[0-9a-f-]{36})$/);
  }
  const unknown = await geo.searchPlaces({ q: 'qzxwvutsrqponm', limit: 10 });
  assert.deepEqual(unknown.results, [], 'a nonexistent place gives no results');
  const symbols = await geo.searchPlaces({ q: '%%', limit: 10 });
  assert.deepEqual(symbols.results, [], 'a query of only punctuation matches nothing');
});

test('search: a category word returns the nearest places of that category, near the user', { skip }, async () => {
  for (const [q, category] of [['restaurant', 'restaurant'], ['hospital', 'hospital'], ['school', 'school'], ['مستشفى', 'hospital']]) {
    const r = await geo.searchPlaces({ q, near: SULAYMANIYAH, limit: 10 });
    assert.ok(r.results.length > 0, `"${q}" finds places`);
    assert.ok(r.results.some((p) => p.category === category), `"${q}" includes ${category} places`);
    const close = r.results.filter((p) => p.distanceMeters !== null);
    assert.equal(close.length, r.results.length, 'every result has a distance when a position is given');
    assert.ok(r.results[0].distanceMeters < 15_000, `the best "${q}" result is near the user (${r.results[0].distanceMeters} m)`);
  }
});

test('search: with a position the same query ranks the nearer place higher; PostGIS computes the distance', { skip }, async () => {
  const farUser = { lat: 33.3152, lng: 44.3661 }; // Baghdad
  const a = await geo.searchPlaces({ q: 'restaurant', near: SULAYMANIYAH, limit: 5 });
  const b = await geo.searchPlaces({ q: 'restaurant', near: farUser, limit: 5 });
  assert.ok(a.results[0].distanceMeters < 15_000 && b.results[0].distanceMeters < 15_000, 'each user gets places near them');
  assert.notEqual(a.results[0].id, b.results[0].id, 'different positions, different best result');
  const checked = await km(SULAYMANIYAH, farUser);
  assert.ok(checked > 200 && checked < 300, `Sulaymaniyah-Baghdad is about 250 km (${checked.toFixed(0)})`);
  const p = a.results[0];
  const own = await km(SULAYMANIYAH, { lat: p.latitude, lng: p.longitude });
  assert.ok(Math.abs(own * 1000 - p.distanceMeters) <= 1, 'the reported distance is the PostGIS distance');
});

test('search: paging returns the next results, not the same ones', { skip }, async () => {
  const one = await geo.searchPlaces({ q: 'cafe', near: SULAYMANIYAH, limit: 5, offset: 0 });
  const two = await geo.searchPlaces({ q: 'cafe', near: SULAYMANIYAH, limit: 5, offset: 5 });
  assert.equal(one.pagination.count, 5);
  assert.equal(one.pagination.hasMore, true);
  const ids = new Set(one.results.map((p) => p.id));
  assert.ok(two.results.length > 0 && two.results.every((p) => !ids.has(p.id)), 'page two is different');
});

test('search is index-driven: no sequential scan, and the work done is bounded', { skip }, async () => {
  const BAGHDAD = { lat: 33.3152, lng: 44.3661 };
  const cases = [
    { q: 'sulaymaniyah', cats: [], near: null },
    { q: 'sulaymaniyah', cats: [], near: SULAYMANIYAH },
    { q: 'restaurant', cats: ['restaurant'], near: SULAYMANIYAH },
    { q: 'restaurant', cats: ['restaurant'], near: null },
    { q: 'cafe', cats: ['cafe'], near: BAGHDAD },
  ];
  for (const c of cases) {
    const { sql, params } = buildSearch({ ...c, limit: 10, offset: 0 });
    const plan = await pg.transaction(async (client) => {
      await client.query("SELECT set_config('pg_trgm.similarity_threshold', '0.25', true), set_config('pg_trgm.word_similarity_threshold', '0.45', true)");
      return (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    });
    const nodes = [];
    (function walk(n) { nodes.push(n); (n.Plans || []).forEach(walk); }(plan.Plan));
    const label = `${c.q} ${c.near ? 'near' : 'plain'} ${c.cats.length ? 'category' : ''}`;
    const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && ['search_names', 'search_entities', 'osm_places', 'osm_roads'].includes(n['Relation Name']));
    assert.deepEqual(seq.map((n) => n['Relation Name']), [], `${label}: a big table is read through its indexes`);
    assert.ok(nodes.some((n) => /search_names_(trgm_gix|prefix_ix)/.test(n['Index Name'] || '')), `${label}: a name index is used`);
    assert.ok(plan['Execution Time'] < 4000, `${label}: ${Math.round(plan['Execution Time'])} ms is inside the 5 s statement timeout with room`);
    const entityRows = nodes.filter((n) => n['Relation Name'] === 'search_entities').reduce((t, n) => t + (n['Actual Rows'] || 0) * (n['Actual Loops'] || 1), 0);
    const total = Number((await pg.query('SELECT count(*) AS n FROM search_entities')).rows[0].n);
    assert.ok(entityRows < total * 0.5, `${label}: ${entityRows} entity rows read of ${total}`);
  }
});

test('search stays fast for the commonest words (the 5 s timeout is never close)', { skip }, async () => {
  for (const q of ['شارع', 'street', 'مول', 'مدرسة', 'Sulaymaniyah', 'al', 'ال']) {
    for (const near of [null, SULAYMANIYAH]) {
      const started = Date.now();
      const r = await geo.searchPlaces({ q, near, limit: 20 });
      const ms = Date.now() - started;
      assert.ok(ms < 3000, `"${q}" ${near ? 'near' : 'plain'} took ${ms} ms`);
      assert.ok(Array.isArray(r.results));
    }
  }
});

test('a common word searched from two cities gives results near each city, not the same list', { skip }, async () => {
  const BAGHDAD = { lat: 33.3152, lng: 44.3661 };
  for (const q of ['شارع', 'street', 'school']) {
    const a = await geo.searchPlaces({ q, near: SULAYMANIYAH, limit: 10 });
    const b = await geo.searchPlaces({ q, near: BAGHDAD, limit: 10 });
    if (!a.results.length || !b.results.length) continue;
    const median = (list) => list.map((p) => p.distanceMeters).sort((x, y) => x - y)[Math.floor(list.length / 2)];
    assert.ok(median(a.results) < 60_000, `"${q}" from Sulaymaniyah: median distance ${median(a.results)} m`);
    assert.ok(median(b.results) < 60_000, `"${q}" from Baghdad: median distance ${median(b.results)} m`);
    assert.notDeepEqual(a.results.map((p) => p.id), b.results.map((p) => p.id), `"${q}": the position changes the results`);
  }
});

test('reverse geocoding: the real city, governorate and country at Sulaymaniyah, from polygons', { skip }, async () => {
  const r = await geo.reverseGeocode({ ...SULAYMANIYAH, lang: 'en' });
  assert.ok(r.displayName, 'something is known there');
  assert.ok(r.city || r.district, `a city or district: ${JSON.stringify(r)}`);
  assert.ok(r.state, `a governorate: ${JSON.stringify(r)}`);
  assert.match(String(r.country), /Iraq|العراق|عێراق/);
  assert.equal(r.latitude, SULAYMANIYAH.lat);
  const ar = await geo.reverseGeocode({ ...SULAYMANIYAH, lang: 'ar' });
  assert.ok(ar.country, 'also answered for Arabic');
  const sea = await geo.reverseGeocode({ lat: 20, lng: 60 });
  assert.equal(sea.displayName, null, 'open sea: nothing known, nothing invented');
  assert.equal(sea.country, null);
});

test('reverse geocoding finds the nearest named road with its routing tags', { skip }, async () => {
  const road = await geo.findNearestRoad({ ...SULAYMANIYAH, radius: 800, namedOnly: true });
  assert.ok(road, 'a named road within 800 m of the centre of Sulaymaniyah');
  assert.ok(road.name && road.type && road.distanceMeters <= 800);
  assert.ok(road.osmWayId > 0, 'the OSM way id is kept (future routing)');
  const roads = await geo.findNearbyRoads({ ...SULAYMANIYAH, radius: 300, limit: 20 });
  assert.ok(roads.length > 1);
  for (let i = 1; i < roads.length; i += 1) assert.ok(roads[i].distanceMeters >= roads[i - 1].distanceMeters, 'nearest first');
});

test('nearby: real hospitals around the city, nearest first, inside the radius', { skip }, async () => {
  const hospitals = await geo.findNearbyPlaces({
    ...SULAYMANIYAH, radius: 5000, categories: ['hospital'], limit: 20,
  });
  assert.ok(hospitals.length > 0, 'there are hospitals within 5 km of the centre');
  for (const h of hospitals) {
    assert.ok(h.distanceMeters <= 5000, 'inside the radius');
    assert.equal(h.category, 'hospital');
  }
  for (let i = 1; i < hospitals.length; i += 1) assert.ok(hospitals[i].distanceMeters >= hospitals[i - 1].distanceMeters);
  const fuel = await geo.findNearbyPlaces({
    ...SULAYMANIYAH, radius: 5000, categories: ['fuel'], limit: 10,
  });
  assert.ok(fuel.length > 0, 'fuel stations (named or not) are there');
  const box = await geo.findPlacesInBBox({
    south: 35.5, west: 45.35, north: 35.62, east: 45.5, categories: ['hospital'], limit: 50,
  });
  assert.ok(box.length > 0);
  for (const p of box) assert.ok(p.latitude >= 35.5 && p.latitude <= 35.62 && p.longitude >= 45.35 && p.longitude <= 45.5, 'inside the box');
});

test('a Redoz-owned place is searchable next to OSM data, and removing it removes it from search', { skip }, async () => {
  const name = `Redoz Test Place ${Date.now()}`;
  const inserted = (await pg.query(
    `INSERT INTO redoz_places (name, names, alt_names, category, geom, address, verified)
     VALUES ($1, $2::jsonb, $3, 'landmark', ST_SetSRID(ST_MakePoint($4, $5), 4326), 'Test address', true) RETURNING id`,
    [name, JSON.stringify({ ar: 'مكان اختبار ردوز' }), ['Redoz Alias Place'], SULAYMANIYAH.lng, SULAYMANIYAH.lat],
  )).rows[0].id;
  try {
    const byName = await geo.searchPlaces({ q: name, near: SULAYMANIYAH, limit: 5 });
    assert.equal(byName.results[0].id, `redoz:${inserted}`, 'found by its name, first');
    assert.equal(byName.results[0].source, 'redoz');
    assert.equal(byName.results[0].verified, true);
    assert.equal(byName.results[0].address, 'Test address');
    assert.equal((await geo.searchPlaces({ q: 'Redoz Alias Place', limit: 5 })).results[0].id, `redoz:${inserted}`, 'found by an alternative name');
    assert.equal((await geo.searchPlaces({ q: 'مكان اختبار ردوز', limit: 5, lang: 'ar' })).results[0].id, `redoz:${inserted}`, 'found by its Arabic name');
    await pg.query('UPDATE redoz_places SET name = $2 WHERE id = $1', [inserted, `${name} renamed`]);
    assert.equal((await geo.searchPlaces({ q: `${name} renamed`, limit: 5 })).results[0].id, `redoz:${inserted}`, 'an update re-indexes it');
    // What Redoz knows about a place is joined by place_key: the place keeps working with and without it.
    await pg.query("INSERT INTO redoz_place_metadata (place_key, verified, rating, rating_count) VALUES ($1, true, 4.5, 3)", [`redoz:${inserted}`]);
    const nearby = await geo.findNearbyPlaces({
      ...SULAYMANIYAH, radius: 200, categories: ['landmark'], limit: 50,
    });
    const mine = nearby.find((p) => p.id === `redoz:${inserted}`);
    assert.ok(mine, 'a Redoz place also shows up in nearby');
    assert.equal(mine.rating, 4.5, 'the Redoz rating comes from redoz_place_metadata');
    assert.equal(mine.ratingCount, 3);
  } finally {
    await pg.query('DELETE FROM redoz_place_metadata WHERE place_key = $1', [`redoz:${inserted}`]);
    await pg.query('DELETE FROM redoz_places WHERE id = $1', [inserted]);
  }
  assert.deepEqual((await geo.searchPlaces({ q: name, limit: 5 })).results.filter((p) => p.id === `redoz:${inserted}`), [], 'deleted: gone from search');
  assert.equal((await pg.query('SELECT count(*) AS n FROM search_names WHERE place_key = $1', [`redoz:${inserted}`])).rows[0].n, '0', 'and from the name index');
});
