#!/usr/bin/env node
/**
 * End-to-end smoke test of the navigation API against a RUNNING backend.
 * Search, reverse geocoding and nearby places are answered by the backend's own
 * PostGIS database (DATABASE_URL, OpenStreetMap import): no provider credit.
 * Routing uses the real routing provider with its key: about three Geoapify
 * requests (one per route type), which count against the daily credit budget.
 * Run it after changing the key, the provider settings or the provider code.
 *
 *   node scripts/smokeNavigation.js [baseUrl] [--write]
 *
 *   baseUrl   default http://localhost:$PORT (PORT from backend/.env, else 3000)
 *   --write   also sign up, log in and delete a throw-away account, create, vote
 *             on and withdraw a community report, and (with SMOKE_ADMIN_TOKEN =
 *             the server's NAV_ADMIN_TOKEN) read the admin overview and create
 *             and delete an operator road feature. Needs MongoDB. Everything
 *             written is withdrawn / deleted again.
 *
 * Points (lat,lng): SMOKE_START, SMOKE_DESTINATION; default two points in
 * Sulaymaniyah (any two points on roads in Iraq work). Exit code 1 if any check fails.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const write = args.includes('--write');
const base = (args.find((a) => /^https?:\/\//.test(a)) || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const adminToken = (process.env.SMOKE_ADMIN_TOKEN || '').trim();
const point = (raw, fallback) => {
  const [lat, lng] = String(raw || fallback).split(',').map(Number);
  return { lat, lng };
};
const START = point(process.env.SMOKE_START, '35.5617,45.4329');
const DESTINATION = point(process.env.SMOKE_DESTINATION, '35.5702,45.4418');

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: err.message });
  }
}

async function call(method, p, { body, token } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
function expect(r, status) {
  if (r.status !== status) throw new Error(`HTTP ${r.status} (expected ${status}): ${r.json && (r.json.code || '')} ${r.json && (r.json.error || '')}`);
  return r.json;
}

(async () => {
  console.log(`Smoke test: ${base}/api/v1${write ? ' (with writes)' : ''}`);
  let config = null;

  await check('GET /config', async () => {
    config = expect(await call('GET', '/api/v1/config'), 200);
    const f = config.features;
    if (!f.routing.available || !f.placeSearch.available) throw new Error('routing or search is not configured: set GEOAPIFY_API_KEY');
    return `routing=${f.routing.available} search=${f.placeSearch.available} reports=${f.reports.available}; attribution "${config.attribution[0].text}"`;
  });

  await check('GET /api/client-config (map style, public values only)', async () => {
    const r = expect(await call('GET', '/api/client-config'), 200);
    if (r.map.provider !== 'openfreemap' || !/^https:\/\//.test(r.map.styleUrl)) throw new Error('no map style URL');
    const key = (process.env.GEOAPIFY_API_KEY || '').trim();
    if (key && JSON.stringify(r).includes(key)) throw new Error('A SERVER KEY IS EXPOSED');
    // The style itself must be reachable: it is what draws the map.
    const style = await fetch(r.map.styleUrl);
    if (!style.ok) throw new Error(`the map style answered HTTP ${style.status}`);
    return `style on ${new URL(r.map.styleUrl).host}, area ${r.map.bounds.south},${r.map.bounds.west} to ${r.map.bounds.north},${r.map.bounds.east}`;
  });

  await check('GET /places/search', async () => {
    const r = expect(await call('GET', `/api/v1/places/search?q=${encodeURIComponent('hospital')}&lat=${START.lat}&lng=${START.lng}&limit=3`), 200);
    if (!r.places.length) throw new Error('no places found');
    return `${r.count} places (${r.scope}); first: ${r.places[0].name}`;
  });

  await check('GET /api/search (own PostGIS search)', async () => {
    const r = expect(await call('GET', `/api/search?q=${encodeURIComponent('hospital')}&lat=${START.lat}&lng=${START.lng}&limit=3`), 200);
    if (!r.results.length) throw new Error('no places found: is the OSM data imported (npm run db:import-osm)?');
    return `${r.count} places; first: ${r.results[0].name} (${r.results[0].distanceMeters} m)`;
  });

  await check('GET /api/geocode/reverse (own PostGIS reverse geocoding)', async () => {
    const r = expect(await call('GET', `/api/geocode/reverse?lat=${START.lat}&lng=${START.lng}`), 200);
    return r.displayName || 'nothing known at this point';
  });

  await check('GET /places/reverse', async () => {
    const r = expect(await call('GET', `/api/v1/places/reverse?lat=${START.lat}&lng=${START.lng}`), 200);
    return r.place ? r.place.address : 'no address at this point';
  });

  await check('GET /places/nearby (fuel)', async () => {
    const r = expect(await call('GET', `/api/v1/places/nearby?lat=${START.lat}&lng=${START.lng}&category=fuel&radius=3000&limit=5`), 200);
    return `${r.count} within ${r.radius} m${r.count ? `; nearest ${r.places[0].distanceMeters} m` : ''}`;
  });

  let firstRoutes = null;
  await check('POST /routes', async () => {
    const r = expect(await call('POST', '/api/v1/routes', { body: { start: START, destination: DESTINATION, maxRoutes: 3, steps: true } }), 200);
    if (!r.routes.length) throw new Error('no routes');
    const best = r.routes[0];
    if (best.geometry.type !== 'LineString' || best.geometry.coordinates.length < 2) throw new Error('bad geometry');
    if (!best.steps || !best.steps.length) throw new Error('no steps');
    firstRoutes = r.routes.map((x) => x.id);
    return `${r.routes.length} routes; best ${Math.round(best.distance)} m / ${Math.round(best.traffic.adjustedDuration)} s; traffic ${r.trafficStatus}; alerts ${r.roadAlertsStatus}; "${best.steps[1] ? best.steps[1].instruction : best.steps[0].instruction}"`;
  });

  await check('POST /routes again (cache)', async () => {
    const r = expect(await call('POST', '/api/v1/routes', { body: { start: START, destination: DESTINATION, maxRoutes: 3 } }), 200);
    if (!r.cached) throw new Error('not served from the cache');
    if (firstRoutes && r.routes.some((x) => !firstRoutes.includes(x.id))) throw new Error('route ids changed');
    return 'cached, same route ids';
  });

  await check('GET /road-features', async () => {
    const d = 0.02;
    const q = `south=${START.lat - d}&west=${START.lng - d}&north=${START.lat + d}&east=${START.lng + d}`;
    const r = expect(await call('GET', `/api/v1/road-features?${q}`), 200);
    return `${r.count} operator features`;
  });

  await check('GET /traffic', async () => {
    const r = expect(await call('GET', '/api/v1/traffic'), 200);
    const by = (s) => r.intersections.filter((i) => i.status === s).length;
    return `${r.count} intersections: ${by('live')} live, ${by('stale')} stale, ${by('no-data')} no data`;
  });

  if (write) {
    let tokenA = null;
    let tokenB = null;
    let reportId = null;
    await check('auth: signup, login, me, wrong password, delete', async () => {
      const email = `smoke_${Date.now()}@example.invalid`;
      const password = 'Smoke-Test-Pass-9';
      const signup = expect(await call('POST', '/api/v1/auth/signup', { body: { email, password } }), 201);
      expect(await call('POST', '/api/v1/auth/login', { body: { email, password: 'wrong-Password-1' } }), 401);
      const login = expect(await call('POST', '/api/v1/auth/login', { body: { email, password } }), 200);
      const me = expect(await call('GET', '/api/v1/auth/me', { token: login.token }), 200);
      if (me.user.email !== email || JSON.stringify(me).includes('passwordHash')) throw new Error('unexpected /auth/me answer');
      expect(await call('GET', '/api/v1/auth/me'), 401);
      expect(await call('DELETE', '/api/v1/auth/me', { token: login.token, body: { password } }), 200);
      return `account ${signup.user.id} created and deleted`;
    });
    await check('POST /auth/device (x2)', async () => {
      tokenA = expect(await call('POST', '/api/v1/auth/device', { body: { platform: 'other', appVersion: 'smoke' } }), 201).token;
      tokenB = expect(await call('POST', '/api/v1/auth/device', { body: { platform: 'other', appVersion: 'smoke' } }), 201).token;
      return 'two device tokens';
    });
    await check('POST /reports', async () => {
      const r = await call('POST', '/api/v1/reports', { token: tokenA, body: { type: 'hazard', ...START, description: 'Smoke test - withdrawn immediately' } });
      const body = r.status === 200 ? r.json : expect(r, 201);
      reportId = body.report.id;
      return `${body.merged ? 'merged into' : 'created'} ${reportId}, expires ${body.report.expiresAt}`;
    });
    await check('GET /reports (area)', async () => {
      const d = 0.005;
      const r = expect(await call('GET', `/api/v1/reports?south=${START.lat - d}&west=${START.lng - d}&north=${START.lat + d}&east=${START.lng + d}`, { token: tokenA }), 200);
      if (!r.reports.some((x) => x.id === reportId)) throw new Error('the new report is not listed');
      return `${r.count} active reports in the area`;
    });
    await check('POST /reports/:id/votes', async () => {
      const r = expect(await call('POST', `/api/v1/reports/${reportId}/votes`, { token: tokenB, body: { vote: 'confirm' } }), 200);
      return `confirmations ${r.report.confirmations}`;
    });
    await check('DELETE /reports/:id', async () => {
      const r = await call('DELETE', `/api/v1/reports/${reportId}`, { token: tokenA });
      if (r.status === 403) return 'merged into someone else\'s report: not withdrawn';
      return `status ${expect(r, 200).report.status}`;
    });
    await check('saved places: create, list, delete (own account)', async () => {
      const email = `smoke_saved_${Date.now()}@example.invalid`;
      const password = 'Smoke-Test-Pass-9';
      const signup = expect(await call('POST', '/api/v1/auth/signup', { body: { email, password } }), 201);
      const created = expect(await call('POST', '/api/v1/saved-places', { token: signup.token, body: { label: 'Smoke home', kind: 'home', ...START } }), 201);
      const list = expect(await call('GET', '/api/v1/saved-places', { token: signup.token }), 200);
      if (!list.savedPlaces.some((p) => p.id === created.savedPlace.id)) throw new Error('the saved place is not listed');
      expect(await call('GET', '/api/v1/saved-places'), 401);
      expect(await call('DELETE', `/api/v1/saved-places/${created.savedPlace.id}`, { token: signup.token }), 200);
      expect(await call('DELETE', '/api/v1/auth/me', { token: signup.token, body: { password } }), 200);
      return 'saved, listed, deleted; account removed';
    });
    if (adminToken) {
      await check('admin: local place create, find in search, delete', async () => {
        const created = expect(await call('POST', '/api/v1/places/local', { token: adminToken, body: { name: 'Smoke test clinic', category: 'hospital', ...DESTINATION } }), 201);
        try {
          const found = expect(await call('GET', '/api/v1/places/search?q=Smoke%20test%20clinic'), 200);
          if (!found.places.some((p) => p.id === `hawr:${created.place.id}`)) throw new Error('the place is not found by search');
        } finally {
          expect(await call('DELETE', `/api/v1/places/local/${created.place.id}`, { token: adminToken }), 200);
        }
        return `created, found by search, deleted ${created.place.id}`;
      });
    }
    if (adminToken) {
      await check('admin: overview', async () => {
        const o = expect(await call('GET', '/api/v1/admin/overview', { token: adminToken }), 200);
        return `search (postgis) ${o.system.places.enabled ? 'enabled' : 'DISABLED'}, geoapify ${o.system.geoapify.enabled ? 'enabled' : 'DISABLED'}, routing ${o.system.routing.provider || 'OFF'}, ${o.users.available ? `${o.users.total} users` : 'no database'}`;
      });
      await check('admin: road feature create / delete', async () => {
        const created = expect(await call('POST', '/api/v1/road-features', { token: adminToken, body: { kind: 'roadworks', ...DESTINATION, name: 'Smoke test' } }), 201);
        expect(await call('DELETE', `/api/v1/road-features/${created.feature.id}`, { token: adminToken }), 200);
        return `created and deleted ${created.feature.id}`;
      });
    }
  }

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(5)} ms  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${results.length} checks failed` : `All ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
