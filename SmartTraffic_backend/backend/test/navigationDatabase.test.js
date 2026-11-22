// Road features and community reports against a REAL MongoDB: geospatial
// queries, indexes, atomic votes, expiry and moderation, through the HTTP
// API. Runs only when MONGODB_TEST_URI is set, e.g.
//
//   MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
//
// It creates a uniquely named database and drops it at the end. Providers
// are the local fake from the harness; time is a test clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const RoadFeature = require('../models/RoadFeature');
const RoadReport = require('../models/RoadReport');
const LocalPlace = require('../models/LocalPlace');
const SavedPlace = require('../models/SavedPlace');
const {
  ADMIN_TOKEN, TEST_KEY, START, DESTINATION, IX, latLng, startFakeProviders, startApi,
} = require('./helpers/navigationHarness');

const uri = (process.env.MONGODB_TEST_URI || '').trim();

if (!uri) {
  test('navigation database tests (set MONGODB_TEST_URI to run them against a real MongoDB)', { skip: 'MONGODB_TEST_URI is not set' }, () => {});
} else {
  const MINUTE = 60_000;
  let clock = Date.now();
  let providers;
  let api;
  const devices = {};

  // Reports away from the route-alert area, each test in its own spot.
  const spot = (n) => ({ lat: 10 + n * 0.01, lng: 10 });
  const box = (p, d = 0.002) => `south=${p.lat - d}&west=${p.lng - d}&north=${p.lat + d}&east=${p.lng + d}`;
  const offset = (p, metres) => ({ lat: p.lat + metres / 110540, lng: p.lng });

  test.before(async () => {
    await mongoose.connect(uri, { dbName: `smarttraffic_navtest_${process.pid}_${Date.now()}`, serverSelectionTimeoutMS: 5000 });
    for (const Model of [RoadFeature, RoadReport, LocalPlace, SavedPlace]) {
      await Model.createCollection();
      await Model.createIndexes();
    }
    providers = await startFakeProviders();
    api = await startApi({ providers: providers.url, isConnected: () => mongoose.connection.readyState === 1, now: () => clock });
    for (const name of ['a', 'b', 'c', 'd', 'e']) devices[name] = await api.deviceToken();
  });

  test.after(async () => {
    if (api) await api.close();
    if (providers) await providers.close();
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect();
  });

  test('collections have their 2dsphere and TTL indexes', async () => {
    const reportIndexes = await RoadReport.collection.indexes();
    assert.ok(reportIndexes.some((i) => i.key.location === '2dsphere' && i.key.status === 1), 'report location index');
    const ttl = reportIndexes.find((i) => i.key.purgeAt === 1);
    assert.equal(ttl.expireAfterSeconds, 0, 'retention TTL index');
    const featureIndexes = await RoadFeature.collection.indexes();
    assert.ok(featureIndexes.some((i) => i.key.location === '2dsphere' && i.key.kind === 1));
  });

  test('operator road features: create, find by area, validity window, update, delete', async () => {
    const p = spot(1);
    const create = (body) => api.post('/api/v1/road-features', body, { token: ADMIN_TOKEN });
    const camera = await create({
      kind: 'speed_camera', ...p, speedLimitKmh: 50, direction: 90, source: 'City traffic department',
    });
    assert.equal(camera.status, 201, JSON.stringify(camera.body));
    assert.equal(camera.body.feature.provider, 'smarttraffic');
    assert.equal(camera.body.feature.verification, 'verified');
    const future = await create({
      kind: 'road_closure', ...offset(p, 50), validFrom: new Date(clock + 60 * MINUTE).toISOString(),
    });
    const outside = await create({ kind: 'speed_bump', ...offset(p, 5000) });
    assert.equal(future.status, 201);
    assert.equal(outside.status, 201);

    const list = await api.get(`/api/v1/road-features?${box(p)}&sources=operator`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.features.map((f) => f.id), [camera.body.feature.id], 'not yet valid and out-of-area features excluded');
    assert.deepEqual(list.body.sources, { operator: 'ok' });

    clock += 61 * MINUTE;
    const later = await api.get(`/api/v1/road-features?${box(p)}&sources=operator&kinds=road_closure`);
    assert.deepEqual(later.body.features.map((f) => f.id), [future.body.feature.id], 'in force once validFrom has passed');

    const off = await api.patch(`/api/v1/road-features/${camera.body.feature.id}`, { active: false }, { token: ADMIN_TOKEN });
    assert.equal(off.body.feature.active, false);
    const hidden = await api.get(`/api/v1/road-features?${box(p)}&sources=operator&kinds=speed_camera`);
    assert.equal(hidden.body.features.length, 0);
    const badWindow = await api.patch(`/api/v1/road-features/${future.body.feature.id}`, { validUntil: new Date(clock - 120 * MINUTE).toISOString() }, { token: ADMIN_TOKEN });
    assert.equal(badWindow.status, 400, 'validUntil before the stored validFrom');

    assert.equal((await api.get(`/api/v1/road-features/${camera.body.feature.id}`)).status, 200);
    assert.equal((await api.del(`/api/v1/road-features/${camera.body.feature.id}`, { token: ADMIN_TOKEN })).status, 200);
    assert.equal((await api.get(`/api/v1/road-features/${camera.body.feature.id}`)).status, 404);
    assert.equal((await api.del('/api/v1/road-features/0123456789abcdef01234567', { token: ADMIN_TOKEN })).status, 404);
    assert.equal((await create({ kind: 'speed_camera', lat: 1 })).status, 400);

    const all = await api.get(`/api/v1/road-features?${box(p)}`);
    assert.deepEqual(all.body.sources, { operator: 'ok' }, 'operator-entered features only: nothing is fetched from elsewhere');
  });

  test('reports: create, duplicate, merge into a nearby report, one vote per device, never on your own', async () => {
    const p = spot(2);
    const created = await api.post('/api/v1/reports', { type: 'accident', ...p, heading: 90, description: 'Two cars' }, { token: devices.a });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const report = created.body.report;
    assert.equal(report.status, 'active');
    assert.equal(report.mine, true);
    assert.equal(report.verification, 'unverified');
    assert.equal(Date.parse(report.expiresAt) - clock, 60 * MINUTE, 'accident TTL');

    const duplicate = await api.post('/api/v1/reports', { type: 'accident', ...offset(p, 20) }, { token: devices.a });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'DUPLICATE_REPORT');
    assert.equal(duplicate.body.reportId, report.id);

    const merged = await api.post('/api/v1/reports', { type: 'accident', ...offset(p, 30) }, { token: devices.b });
    assert.equal(merged.status, 200);
    assert.equal(merged.body.merged, true);
    assert.equal(merged.body.report.id, report.id);
    assert.equal(merged.body.report.confirmations, 1);
    assert.equal(merged.body.report.myVote, 'confirm');

    const otherType = await api.post('/api/v1/reports', { type: 'hazard', ...offset(p, 30) }, { token: devices.b });
    assert.equal(otherType.status, 201, 'a different type at the same place is a new report');

    const again = await api.post(`/api/v1/reports/${report.id}/votes`, { vote: 'confirm' }, { token: devices.b });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'ALREADY_VOTED');
    const own = await api.post(`/api/v1/reports/${report.id}/votes`, { vote: 'dismiss' }, { token: devices.a });
    assert.equal(own.status, 403);
    assert.equal(own.body.code, 'CANNOT_VOTE_OWN_REPORT');

    // A confirmation 40 minutes in extends the report to 60 minutes from then.
    clock += 40 * MINUTE;
    const confirmed = await api.post(`/api/v1/reports/${report.id}/votes`, { vote: 'confirm' }, { token: devices.c });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.report.confirmations, 2);
    assert.equal(Date.parse(confirmed.body.report.expiresAt), clock + 60 * MINUTE);

    const list = await api.get(`/api/v1/reports?${box(p)}`, { token: devices.c });
    const listed = list.body.reports.find((r) => r.id === report.id);
    assert.equal(listed.myVote, 'confirm');
    assert.equal(listed.mine, false);
    assert.equal((await api.get(`/api/v1/reports?${box(p)}&types=hazard`)).body.reports.length, 1);

    // Device ids never leave the server.
    const raw = JSON.stringify(list.body);
    assert.doesNotMatch(raw, /reporterId|votes|deviceId/);
    const anonymous = await api.get(`/api/v1/reports/${report.id}`);
    assert.equal(anonymous.body.report.mine, undefined, 'mine/myVote only with a device token');
  });

  test('votes are atomic: concurrent votes from one device count once', async () => {
    const p = spot(3);
    const { body } = await api.post('/api/v1/reports', { type: 'traffic_jam', ...p }, { token: devices.a });
    const results = await Promise.all(Array.from({ length: 5 }, () => api.post(`/api/v1/reports/${body.report.id}/votes`, { vote: 'confirm' }, { token: devices.d })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === 'ALREADY_VOTED'));
    const stored = await RoadReport.findById(body.report.id).lean();
    assert.equal(stored.confirmations, 1);
    assert.equal(stored.votes.length, 1);
  });

  test('dismissals hide a report; its reporter can withdraw; it expires on time', async () => {
    const p = spot(4);
    const hazard = (await api.post('/api/v1/reports', { type: 'hazard', ...p }, { token: devices.a })).body.report;
    for (const d of ['b', 'c']) assert.equal((await api.post(`/api/v1/reports/${hazard.id}/votes`, { vote: 'dismiss' }, { token: devices[d] })).body.report.status, 'active');
    const third = await api.post(`/api/v1/reports/${hazard.id}/votes`, { vote: 'dismiss' }, { token: devices.d });
    assert.equal(third.body.report.status, 'dismissed', 'three dismissals, no confirmations');
    assert.equal((await api.get(`/api/v1/reports?${box(p)}`)).body.reports.length, 0);
    assert.equal((await api.get(`/api/v1/reports/${hazard.id}`)).body.report.status, 'dismissed');

    const q = spot(5);
    const jam = (await api.post('/api/v1/reports', { type: 'traffic_jam', ...q }, { token: devices.a })).body.report;
    const notMine = await api.del(`/api/v1/reports/${jam.id}`, { token: devices.b });
    assert.equal(notMine.status, 403);
    assert.equal(notMine.body.code, 'NOT_REPORT_OWNER');
    assert.equal((await api.del(`/api/v1/reports/${jam.id}`, { token: devices.a })).body.report.status, 'withdrawn');
    const twice = await api.del(`/api/v1/reports/${jam.id}`, { token: devices.a });
    assert.equal(twice.body.code, 'REPORT_NOT_ACTIVE');

    const r = spot(6);
    const closure = (await api.post('/api/v1/reports', { type: 'road_closure', ...r }, { token: devices.a })).body.report;
    clock += 241 * MINUTE; // road_closure TTL is 240 min
    assert.equal((await api.get(`/api/v1/reports/${closure.id}`)).body.report.status, 'expired');
    assert.equal((await api.get(`/api/v1/reports?${box(r)}`)).body.reports.length, 0);
    const late = await api.post(`/api/v1/reports/${closure.id}/votes`, { vote: 'confirm' }, { token: devices.b });
    assert.equal(late.body.code, 'REPORT_NOT_ACTIVE');
  });

  test('moderation: verify, remove (retention starts), reactivate restarts the lifetime', async () => {
    const p = spot(7);
    const report = (await api.post('/api/v1/reports', { type: 'construction', ...p }, { token: devices.a })).body.report;
    const verified = await api.patch(`/api/v1/reports/${report.id}`, { verification: 'verified' }, { token: ADMIN_TOKEN });
    assert.equal(verified.body.report.verification, 'verified');

    const removed = await api.patch(`/api/v1/reports/${report.id}`, { status: 'removed' }, { token: ADMIN_TOKEN });
    assert.equal(removed.body.report.status, 'removed');
    const stored = await RoadReport.findById(report.id).lean();
    assert.equal(stored.purgeAt.getTime(), clock + 30 * 86_400_000, 'deleted by MongoDB 30 days after removal');

    clock += 25 * 60 * MINUTE; // construction TTL is 24 h: now past it
    const back = await api.patch(`/api/v1/reports/${report.id}`, { status: 'active' }, { token: ADMIN_TOKEN });
    assert.equal(back.body.report.status, 'active');
    assert.equal(Date.parse(back.body.report.expiresAt), clock + 24 * 60 * MINUTE);
    assert.equal((await api.patch(`/api/v1/reports/${report.id}`, { status: 'dismissed' }, { token: ADMIN_TOKEN })).status, 400);
    assert.equal((await api.patch(`/api/v1/reports/${report.id}`, { status: 'removed' }, { token: devices.a })).status, 401);
  });

  test('map-area queries include points near the edges of wide boxes (geodesic polygon edges)', async () => {
    const { bboxPolygon } = require('../utils/geo');
    const bbox = { south: 40, west: 20, north: 40.5, east: 20.5 };
    const inside = (await api.post('/api/v1/reports', { type: 'hazard', lat: 40.00005, lng: 20.25 }, { token: devices.b })).body.report;
    const outside = (await api.post('/api/v1/reports', { type: 'hazard', lat: 39.99995, lng: 20.3 }, { token: devices.c })).body.report;
    // The reason for bboxQueryPolygon: a plain polygon's south edge bows north and misses the point 5 m inside.
    const plain = await RoadReport.find({ location: { $geoWithin: { $geometry: bboxPolygon(bbox) } } }).lean();
    assert.equal(plain.some((d) => String(d._id) === inside.id), false, 'MongoDB edges are great circles');
    const listed = await api.get(`/api/v1/reports?south=${bbox.south}&west=${bbox.west}&north=${bbox.north}&east=${bbox.east}`);
    const ids = listed.body.reports.map((r) => r.id);
    assert.ok(ids.includes(inside.id), '5 m inside the box');
    assert.equal(ids.includes(outside.id), false, '5 m outside the box');
  });

  test('a device may have only a few active reports at once', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await api.post('/api/v1/reports', { type: 'hazard', ...spot(20 + i) }, { token: devices.e });
      assert.equal(r.status, 201);
    }
    const sixth = await api.post('/api/v1/reports', { type: 'hazard', ...spot(30) }, { token: devices.e });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, 'REPORT_LIMIT_REACHED');
  });

  test('routes list the reports and closures along them', async () => {
    const onRoute = (await api.post('/api/v1/reports', { type: 'accident', ...IX }, { token: devices.b })).body.report;
    const closure = (await api.post('/api/v1/road-features', { kind: 'road_closure', ...latLng(600, 0), name: 'East Lane' }, { token: ADMIN_TOKEN })).body.feature;
    const r = await api.post('/api/v1/routes', { start: START, destination: DESTINATION });
    assert.equal(r.status, 200);
    assert.equal(r.body.roadAlertsStatus, 'ok');
    const through = r.body.routes.find((x) => x.duration === 600);
    const bypass = r.body.routes.find((x) => x.duration === 640);
    const accident = through.roadAlerts.find((a) => a.id === onRoute.id);
    assert.ok(accident, 'the accident on the route is listed');
    assert.equal(accident.type, 'report');
    assert.match(accident.message, /Accident reported by drivers/);
    assert.ok(Math.abs(accident.alongMeters - 800) < 10, `along ${accident.alongMeters}`);
    assert.ok(bypass.roadAlerts.some((a) => a.id === closure.id && a.message === 'Road closed: East Lane'));
    assert.equal(bypass.roadAlerts.some((a) => a.id === onRoute.id), false, 'not on the bypass');
  });

  test('admin console: overview counts, users (no password data), reports and features in any status, paging, filters', async () => {
    const admin = { token: ADMIN_TOKEN };
    for (const email of ['zed.admin.a@example.invalid', 'zed.admin.b@example.invalid', 'other.person@example.invalid']) {
      assert.equal((await api.post('/api/v1/auth/signup', { email, password: 'Correct-Horse-9' })).status, 201);
    }
    const p = spot(20);
    const report = await api.post('/api/v1/reports', { type: 'traffic_jam', ...p }, { token: devices.a });
    assert.equal(report.status, 201);
    const feature = await api.post('/api/v1/road-features', { kind: 'speed_bump', ...spot(21), active: false }, admin);
    assert.equal(feature.status, 201);

    const overview = await api.get('/api/v1/admin/overview', admin);
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.users.available, true);
    assert.ok(overview.body.users.total >= 3 && overview.body.users.last7Days >= 3);
    assert.ok(overview.body.reports.byStatus.active >= 1);
    assert.ok(overview.body.reports.activeByType.traffic_jam >= 1);
    assert.ok(overview.body.roadFeatures.total >= 1 && overview.body.roadFeatures.byKind.speed_bump >= 1);
    assert.ok(overview.body.roadFeatures.active < overview.body.roadFeatures.total, 'the inactive feature is counted but not active');
    assert.equal(overview.body.system.geoapify.enabled, true);
    assert.equal(JSON.stringify(overview.body).includes(TEST_KEY), false, 'no key in the overview');

    const users = await api.get('/api/v1/admin/users?q=ZED.admin', admin);
    assert.equal(users.status, 200);
    assert.equal(users.body.total, 2, 'prefix search, case-insensitive');
    assert.deepEqual(Object.keys(users.body.users[0]).sort(), ['createdAt', 'email', 'id', 'name']);
    assert.equal(JSON.stringify(users.body).includes('passwordHash'), false);
    const paged = await api.get('/api/v1/admin/users?q=zed.admin&limit=1&page=2', admin);
    assert.equal(paged.body.users.length, 1);
    assert.equal(paged.body.total, 2);
    assert.equal((await api.get('/api/v1/admin/users?q=.*', admin)).status, 400, 'a pattern is not an email prefix');
    assert.equal((await api.get('/api/v1/admin/users?q=%7B%22%24ne%22%3A1%7D', admin)).status, 400, 'no operators');
    assert.equal((await api.get('/api/v1/admin/users?limit=1000', admin)).status, 400);

    const reports = await api.get('/api/v1/admin/reports?status=active&type=traffic_jam', admin);
    assert.ok(reports.body.reports.some((r) => r.id === report.body.report.id));
    assert.equal(JSON.stringify(reports.body).includes('reporterId'), false);
    assert.equal((await api.get('/api/v1/admin/reports?status=nonsense', admin)).status, 400);
    await api.patch(`/api/v1/reports/${report.body.report.id}`, { status: 'removed' }, admin);
    const removed = await api.get('/api/v1/admin/reports?status=removed', admin);
    assert.ok(removed.body.reports.some((r) => r.id === report.body.report.id), 'the console sees removed reports the public list hides');

    const inactive = await api.get('/api/v1/admin/road-features?active=false&kind=speed_bump', admin);
    assert.ok(inactive.body.features.some((f) => f.id === feature.body.feature.id), 'inactive features are listed for the operator');
    const activeOnly = await api.get('/api/v1/admin/road-features?active=true', admin);
    assert.equal(activeOnly.body.features.some((f) => f.id === feature.body.feature.id), false);
    assert.equal((await api.get('/api/v1/admin/road-features?active=maybe', admin)).status, 400);
  });

  test('local places: admin CRUD, public map layer, searched before the provider, names per language, hidden when inactive', async () => {
    const admin = { token: ADMIN_TOKEN };
    const p = spot(30);
    const body = { name: 'Hawr Test Clinic', nameAr: 'عيادة هاور', nameKu: 'کلینیکی هاور', category: 'hospital', ...p, description: 'Entered by the operator' };
    assert.equal((await api.post('/api/v1/places/local', body)).status, 401, 'admin only');
    assert.equal((await api.post('/api/v1/places/local', body, { token: devices.a })).status, 401);
    assert.equal((await api.post('/api/v1/places/local', { ...body, category: 'volcano' }, admin)).status, 400);
    assert.equal((await api.post('/api/v1/places/local', { ...body, lat: 999 }, admin)).status, 400);
    assert.equal((await api.post('/api/v1/places/local', { ...body, $where: 'x' }, admin)).status, 400);
    const created = await api.post('/api/v1/places/local', body, admin);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.place.id;

    const layer = await api.get(`/api/v1/places/local?${box(p)}`);
    assert.equal(layer.status, 200);
    assert.deepEqual(layer.body.places.map((x) => [x.id, x.name, x.category]), [[id, 'Hawr Test Clinic', 'hospital']]);
    assert.equal((await api.get(`/api/v1/places/local?${box(p)}&categories=fuel`)).body.count, 0, 'category filter');
    assert.equal((await api.get('/api/v1/places/local?south=1&west=1&north=9&east=9')).status, 400, 'an area wider than the limit');
    assert.equal((await api.get(`/api/v1/places/local/${id}`)).body.place.nameKu, 'کلینیکی هاور');

    const found = await api.get('/api/v1/places/search?q=Test%20Clinic&lang=ku&limit=5');
    assert.equal(found.status, 200);
    assert.equal(found.body.places[0].id, `hawr:${id}`, 'the operator own place comes first');
    assert.equal(found.body.places[0].source, 'hawr');
    assert.equal(found.body.places[0].name, 'کلینیکی هاور', 'the Kurdish name when Kurdish is asked for');
    assert.equal((await api.get(`/api/v1/places/search?q=${encodeURIComponent('هاور')}&lang=ar`)).body.places[0].name, 'عيادة هاور', 'found by its Arabic name too');
    assert.equal((await api.get('/api/v1/places/search?q=%5B.*%5D')).body.places.some((x) => x.source === 'hawr'), false, 'a regex in the query is text, not a pattern');

    const listed = await api.get('/api/v1/admin/places?category=hospital&active=true', admin);
    assert.ok(listed.body.places.some((x) => x.id === id));
    const patched = await api.patch(`/api/v1/places/local/${id}`, { active: false }, admin);
    assert.equal(patched.status, 200);
    assert.equal((await api.get(`/api/v1/places/local?${box(p)}`)).body.count, 0, 'a hidden place is not on the map');
    assert.equal((await api.get('/api/v1/places/search?q=Test%20Clinic')).body.places.some((x) => x.source === 'hawr'), false, 'nor in search');
    assert.ok((await api.get('/api/v1/admin/places?active=false', admin)).body.places.some((x) => x.id === id), 'but the console still lists it');
    assert.equal((await api.patch(`/api/v1/places/local/${id}`, {}, admin)).status, 400, 'nothing to change');
    assert.equal((await api.get('/api/v1/admin/overview', admin)).body.localPlaces.total >= 1, true);
    assert.equal((await api.del(`/api/v1/places/local/${id}`, admin)).status, 200);
    assert.equal((await api.get(`/api/v1/places/local/${id}`)).status, 404);
  });

  test('saved places: only for a signed-in user, private to that user, capped, removed with the account', async () => {
    const signup = async (email) => (await api.post('/api/v1/auth/signup', { email, password: 'Correct-Horse-9' })).body.token;
    const sara = await signup('saved.sara@example.invalid');
    const omar = await signup('saved.omar@example.invalid');
    const here = { lat: 36.19, lng: 44.01 };

    assert.equal((await api.get('/api/v1/saved-places')).status, 401);
    assert.equal((await api.get('/api/v1/saved-places', { token: devices.a })).status, 401, 'a device token is not a user token');
    assert.equal((await api.post('/api/v1/saved-places', { label: 'x', lat: 999, lng: 1 }, { token: sara })).status, 400);
    assert.equal((await api.post('/api/v1/saved-places', { label: '', ...here }, { token: sara })).status, 400);
    assert.equal((await api.post('/api/v1/saved-places', { label: 'Home', kind: 'castle', ...here }, { token: sara })).status, 400);
    assert.equal((await api.post('/api/v1/saved-places', { label: 'Home', userId: 'someone-else', ...here }, { token: sara })).status, 400, 'the owner is never taken from the body');

    const home = await api.post('/api/v1/saved-places', { label: 'Home', kind: 'home', address: 'Erbil', ...here }, { token: sara });
    assert.equal(home.status, 201, JSON.stringify(home.body));
    assert.equal(JSON.stringify(home.body).includes('userId'), false, 'the owner is not returned');
    const id = home.body.savedPlace.id;
    assert.deepEqual((await api.get('/api/v1/saved-places', { token: sara })).body.savedPlaces.map((x) => x.label), ['Home']);
    assert.deepEqual((await api.get('/api/v1/saved-places', { token: omar })).body.savedPlaces, [], 'another user does not see it');
    assert.equal((await api.patch(`/api/v1/saved-places/${id}`, { label: 'Mine now' }, { token: omar })).status, 404, 'nor change it');
    assert.equal((await api.del(`/api/v1/saved-places/${id}`, { token: omar })).status, 404, 'nor delete it');
    const renamed = await api.patch(`/api/v1/saved-places/${id}`, { label: 'Home sweet home' }, { token: sara });
    assert.equal(renamed.body.savedPlace.label, 'Home sweet home');
    assert.equal((await api.patch(`/api/v1/saved-places/${id}`, {}, { token: sara })).status, 400);

    // the cap
    for (let i = 1; i < 100; i += 1) assert.equal((await api.post('/api/v1/saved-places', { label: `Place ${i}`, ...here }, { token: sara })).status, 201);
    const over = await api.post('/api/v1/saved-places', { label: 'One too many', ...here }, { token: sara });
    assert.equal(over.status, 409);
    assert.equal(over.body.code, 'SAVED_PLACE_LIMIT');

    // a logout revokes the token: the places are no longer readable with it
    const login = await api.post('/api/v1/auth/login', { email: 'saved.sara@example.invalid', password: 'Correct-Horse-9' });
    await api.post('/api/v1/auth/logout', undefined, { token: login.body.token });
    assert.equal((await api.get('/api/v1/saved-places', { token: login.body.token })).status, 401);

    // deleting the account deletes its saved places
    const again = await api.post('/api/v1/auth/login', { email: 'saved.sara@example.invalid', password: 'Correct-Horse-9' });
    assert.equal((await api.del('/api/v1/auth/me', { token: again.body.token, body: { password: 'Correct-Horse-9' } })).status, 200);
    assert.equal(await SavedPlace.countDocuments({}), 0, 'no saved place of the deleted account is left');
  });
}