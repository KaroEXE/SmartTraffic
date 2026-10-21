// The 3D street network (frontend/three/network.js, site.js, trafficLights.js,
// intersection.js): layout from the backend's intersection list, and every
// intersection's signals and traffic driven only by its own snapshots.
// Tested without a browser (no WebGL renderer needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
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

const simulationIntersections = require('../config/simulationIntersections');
const liveIntersections = require('../config/intersections');

const SPACING = 200;

// ------------------------------------------------------------- layout

test('every simulated intersection sits on its configured grid cell (the backend topology)', async () => {
  const { layoutNetwork } = await frontend('three/network.js');
  const layout = layoutNetwork(simulationIntersections, { spacing: SPACING });

  assert.equal(layout.cols, 3);
  assert.equal(layout.rows, 2);
  assert.equal(layout.slots.length, 6);
  assert.deepEqual(layout.sites.map((s) => s.id).sort(), simulationIntersections.map((i) => i.id).sort());

  // North row first (smaller z), west to east within a row.
  const byId = Object.fromEntries(layout.sites.map((s) => [s.id, s]));
  assert.deepEqual(
    layout.sites.filter((s) => s.row === 0).map((s) => s.id),
    ['hospital-junction', 'ring-road-north', 'university-road'],
  );
  assert.deepEqual(layout.sites.filter((s) => s.row === 1).map((s) => s.id), ['main', 'market-square', 'stadium-road']);
  for (const ix of simulationIntersections) {
    assert.deepEqual([byId[ix.id].col, byId[ix.id].row], [ix.grid.col, ix.grid.row], `${ix.id} on its configured cell`);
  }
  assert.ok(byId['ring-road-north'].z < byId.main.z, 'northern intersections are further north (-z)');
  assert.ok(byId['market-square'].x > byId.main.x, 'eastern intersections are further east (+x)');

  // Regular grid: unique positions exactly `spacing` apart, so the legs meet.
  const keys = new Set(layout.slots.map((s) => `${s.x},${s.z}`));
  assert.equal(keys.size, layout.slots.length, 'no two junctions share a position');
  for (const s of layout.slots) {
    assert.equal((s.x - layout.bounds.minX) % SPACING, 0);
    assert.equal((s.z - layout.bounds.minZ) % SPACING, 0);
  }
  assert.equal(layout.slots.filter((s) => !s.id).length, 0, 'the simulated grid is complete');
  // Live: five intersections on the same cells; the sixth cell is a plain junction.
  const live = layoutNetwork(liveIntersections, { spacing: SPACING });
  assert.deepEqual(live.slots.filter((s) => !s.id).map((s) => [s.col, s.row]), [[2, 1]]);
});

// --------------------------------------------- network decision -> 3D view

const DECISION = {
  dataMode: 'simulation',
  cycle: 7,
  links: [
    { id: 'main>market-square', from: 'main', to: 'market-square', state: 'congested', releasing: true, queue: 30, capacity: 40 },
    { id: 'market-square>stadium-road', from: 'market-square', to: 'stadium-road', state: 'blocked', releasing: false, queue: 38, capacity: 40 },
    { id: 'market-square>main', from: 'market-square', to: 'main', state: 'nonsense', releasing: false, queue: null, capacity: 40 },
  ],
  intersections: [
    { intersectionId: 'main', evaluated: true, changed: false, networkChangedChoice: true, candidates: [], emergency: false, applied: 'applied' },
    { intersectionId: 'market-square', evaluated: true, changed: false, candidates: [{ queue: 3, downstream: { state: 'blocked' } }], emergency: false, applied: 'pending: minimum green' },
    { intersectionId: 'ring-road-north', evaluated: true, changed: false, candidates: [{ queue: 2, downstream: { state: 'free' } }], emergency: false, applied: 'applied' },
    { intersectionId: 'university-road', evaluated: false, status: 'stale' },
    { intersectionId: 'hospital-junction', evaluated: false, status: 'nodata' },
    { intersectionId: 'stadium-road', evaluated: true, changed: false, candidates: [], emergency: false, applied: 'applied' },
  ],
  corridors: [{
    vehicleId: 'ambulance-1',
    type: 'ambulance',
    source: 'simulation',
    position: { towards: 'stadium-road', approach: 'west', distanceM: 50 },
    route: ['main', 'market-square', 'stadium-road'],
    passed: ['main', 'market-square'],
    entries: [{ intersectionId: 'stadium-road', approach: 'west', etaSeconds: 4, stage: 'holding', status: 'ok' }],
    support: [],
  }],
};

test('the 3D network shows exactly the decision: road states, highlights, corridor', async () => {
  const view = await frontend('three/networkView.js');
  const links = view.linkStates(DECISION);
  assert.deepEqual(links.get('main>market-square'), { state: 'congested', releasing: true, corridor: false, queue: 30, capacity: 40 });
  assert.equal(links.get('market-square>stadium-road').state, 'blocked');
  assert.equal(links.get('market-square>main').state, 'unknown', 'unknown states are shown as unknown');
  assert.equal(links.get('market-square>stadium-road').corridor, true, 'the road the vehicle is on is part of the corridor');
  assert.equal(links.get('main>market-square').corridor, false, 'the part already driven is not highlighted');

  const corridors = view.corridorIndex(DECISION);
  const state = (id) => view.siteState(DECISION.intersections.find((r) => r.intersectionId === id), corridors);
  assert.equal(state('stadium-road'), 'emergency');
  assert.equal(state('main'), 'action', 'the network changed its choice this cycle');
  assert.equal(state('market-square'), 'congested');
  assert.equal(state('ring-road-north'), 'normal');
  assert.equal(state('university-road'), 'stale');
  assert.equal(state('hospital-junction'), 'nodata');
  assert.equal(view.siteState(undefined, corridors), 'nodata', 'no record = no claim');

  const { layoutNetwork } = await frontend('three/network.js');
  const layout = layoutNetwork(simulationIntersections, { spacing: SPACING });
  const sites = new Map(layout.sites.map((s) => [s.id, s]));
  const stadium = sites.get('stadium-road');
  // 50 m before the stop line (13 m from the centre) on the west leg, travelling east.
  assert.deepEqual(view.vehiclePosition(DECISION.corridors[0].position, sites, 13), { x: stadium.x - 63, z: stadium.z, heading: 'east' });
  assert.deepEqual(view.corridorPath(DECISION.corridors[0], sites, 13), [{ x: stadium.x - 63, z: stadium.z }, { x: stadium.x, z: stadium.z }]);
  assert.equal(view.vehiclePosition({ towards: 'atlantis', approach: 'west', distanceM: 5 }, sites), null);

  const s = view.summarize(DECISION);
  assert.deepEqual([s.evaluated, s.total, s.applied, s.pending, s.networkChanged, s.corridors, s.congestedLinks], [4, 6, 3, 1, 1, 1, 2]);
});

test('the 3D roads are the backend topology: every link joins two neighbouring junctions in the scene', async () => {
  const { buildTopology } = require('../services/networkTopology');
  const { layoutNetwork } = await frontend('three/network.js');
  for (const list of [liveIntersections, simulationIntersections]) {
    const topo = buildTopology(list, require('../config').network);
    const layout = layoutNetwork(list, { spacing: topo.linkLengthM });
    const sites = new Map(layout.sites.map((s) => [s.id, s]));
    assert.deepEqual([...sites.keys()].sort(), topo.nodes.map((n) => n.id).sort(), 'same ids in the scene and the backend');
    for (const l of topo.links) {
      const a = sites.get(l.from);
      const b = sites.get(l.to);
      assert.equal(Math.hypot(b.x - a.x, b.z - a.z), topo.linkLengthM, `${l.id} spans one block`);
      const step = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[l.heading];
      assert.deepEqual([Math.sign(b.x - a.x), Math.sign(b.z - a.z)], step, `${l.id} heads ${l.heading} in the scene`);
    }
  }
});

test('every live intersection gets a junction; spare grid slots get no signals', async () => {
  const { layoutNetwork } = await frontend('three/network.js');
  const layout = layoutNetwork(liveIntersections, { spacing: SPACING });
  assert.deepEqual(layout.sites.map((s) => s.id).sort(), liveIntersections.map((i) => i.id).sort());
  assert.ok(layout.sites.length >= 4, 'at least four connected intersections');
  assert.equal(layout.slots.filter((s) => !s.id).length, layout.slots.length - liveIntersections.length,
    'no signals are invented for junctions the backend does not manage');
  // A deployment that lists only one intersection still gets a street grid.
  const one = layoutNetwork([liveIntersections[0]], { spacing: SPACING });
  assert.equal(one.slots.length, 4);
  assert.equal(one.sites.length, 1);
});

test('the layout is data-driven: stable, de-duplicated, and extensible without code changes', async () => {
  const { layoutNetwork } = await frontend('three/network.js');
  const list = [
    { id: 'a', name: 'A', lat: 1, lng: 1 },
    { id: 'b', name: 'B', lat: 1, lng: 2 },
    { id: 'a', name: 'duplicate' },
    null,
    { id: '' },
  ];
  const one = layoutNetwork(list, { spacing: SPACING });
  const two = layoutNetwork([list[1], list[0], ...list.slice(2)], { spacing: SPACING });
  assert.deepEqual(one.sites.map((s) => s.id), ['a', 'b']);
  assert.equal(one.sites[0].name, 'A', 'the first entry of a duplicated id wins');
  assert.deepEqual(one.sites, two.sites, 'input order does not move intersections with coordinates');

  // An intersection added to the backend list (even without coordinates) gets a junction.
  const more = layoutNetwork([...list, { id: 'c', name: 'C' }, { id: 'd' }, { id: 'e' }], { spacing: SPACING });
  assert.deepEqual(more.sites.map((s) => s.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(more.cols * more.rows >= 5, true);
  assert.equal(more.sites.find((s) => s.id === 'd').name, 'd', 'falls back to the id as its name');

  assert.throws(() => layoutNetwork(list, { spacing: 0 }));
});

// ------------------------------------------------------ intersections

const snap = (id, signals, extra = {}) => ({
  intersectionId: id,
  signals,
  pedestrianSignals: { north: 'DONT_WALK', south: 'DONT_WALK', east: 'DONT_WALK', west: 'DONT_WALK' },
  traffic: {},
  ...extra,
});
const NS_GREEN = { north: 'GREEN', south: 'GREEN', east: 'RED', west: 'RED' };
const EW_GREEN = { north: 'RED', south: 'RED', east: 'GREEN', west: 'GREEN' };
const NS_YELLOW = { north: 'YELLOW', south: 'YELLOW', east: 'RED', west: 'RED' };

async function twoSites() {
  const THREE = await import(threeUrl);
  const { IntersectionSite } = await frontend('three/site.js');
  const parent = new THREE.Group();
  const a = new IntersectionSite(parent, { id: 'main', name: 'Main', x: 0, z: 0 });
  const b = new IntersectionSite(parent, { id: 'market-square', name: 'Market', x: 200, z: 0 });
  return { THREE, parent, a, b };
}

const lit = (site, dir, color) => site.lights.units[dir].mats[color].emissiveIntensity > 1;

test('each intersection shows its own signals; updating one leaves the others alone', async () => {
  const { a, b } = await twoSites();
  assert.notEqual(a.lights.units.north.mats.GREEN, b.lights.units.north.mats.GREEN, 'no shared lamp materials');

  a.apply(snap('main', NS_GREEN), 'simulation');
  b.apply(snap('market-square', EW_GREEN), 'simulation');
  assert.deepEqual(a.lights.signals, NS_GREEN);
  assert.deepEqual(b.lights.signals, EW_GREEN);
  assert.ok(lit(a, 'north', 'GREEN') && lit(a, 'east', 'RED'));
  assert.ok(lit(b, 'north', 'RED') && lit(b, 'east', 'GREEN'));

  // A changes phase: B's lamps do not move.
  a.apply(snap('main', NS_YELLOW), 'simulation');
  assert.deepEqual(a.lights.signals, NS_YELLOW);
  assert.ok(lit(a, 'north', 'YELLOW') && !lit(a, 'north', 'GREEN'));
  assert.deepEqual(b.lights.signals, EW_GREEN);
  assert.ok(lit(b, 'east', 'GREEN') && !lit(b, 'north', 'YELLOW'));
});

test('a snapshot for another intersection id is refused and changes nothing', async () => {
  const { a } = await twoSites();
  a.apply(snap('main', NS_GREEN), 'simulation');
  assert.equal(a.apply(snap('market-square', EW_GREEN), 'simulation'), false);
  assert.deepEqual(a.lights.signals, NS_GREEN);
  assert.equal(a.snapshot.intersectionId, 'main');
});

test('signals stay dark until the backend has sent a state for that intersection', async () => {
  const { a, b } = await twoSites();
  a.apply(snap('main', NS_GREEN), 'live');
  assert.equal(b.lights.known, false);
  assert.deepEqual(b.lights.signals, { north: null, south: null, east: null, west: null });
  for (const color of ['RED', 'YELLOW', 'GREEN']) assert.ok(!lit(b, 'north', color), `${color} is off`);
  // Beacons never show an unknown state, even from the overview.
  b.lights.setBeaconOpacity(1);
  assert.equal(b.lights.units.north.beacon.visible, false);
  a.lights.setBeaconOpacity(1);
  assert.equal(a.lights.units.north.beacon.visible, true);
});

test('vehicles and data state are per intersection', async () => {
  const { a, b } = await twoSites();
  const traffic = (n) => ({
    north: { vehicles: n }, south: { vehicles: n }, east: { vehicles: n }, west: { vehicles: n },
  });
  const ALL_RED = { north: 'RED', south: 'RED', east: 'RED', west: 'RED' };
  a.apply(snap('main', ALL_RED, { traffic: traffic(4) }), 'live');
  b.apply(snap('market-square', ALL_RED, { traffic: traffic(9) }), 'stale');

  for (let t = 0; t < 20; t += 0.05) {
    for (const site of [a, b]) if (!site.isFrozen(false)) site.update(0.05, t);
  }
  assert.equal(a.vehicles.countOnApproach('north'), 4, 'live intersection follows its own count');
  assert.equal(b.vehicles.count(), 0, 'stale data adds no vehicles at another intersection');
  assert.equal(a.isFrozen(false), false);
  assert.equal(b.isFrozen(false), true, 'only the stale intersection freezes');
  assert.equal(a.isFrozen(true), true, 'a paused simulation freezes every intersection');

  // Data for B resumes: B fills, A is untouched.
  b.apply(snap('market-square', ALL_RED, { traffic: traffic(2) }), 'live');
  assert.equal(b.vehicles.countOnApproach('east'), 2);
  assert.equal(a.vehicles.countOnApproach('east'), 4);

  // Waiting (no AI data) clears only that intersection.
  a.setDataState('waiting');
  assert.equal(a.vehicles.count(), 0);
  assert.equal(b.vehicles.countOnApproach('east'), 2);
});

test('disposing an intersection removes its objects and frees its own materials only', async () => {
  const { parent, a, b } = await twoSites();
  a.apply(snap('main', NS_GREEN), 'simulation');
  let disposed = 0;
  a.lights.units.north.mats.GREEN.addEventListener('dispose', () => { disposed += 1; });
  a.dispose();
  assert.equal(disposed, 1);
  assert.deepEqual(parent.children, [b.group]);
  b.apply(snap('market-square', EW_GREEN), 'simulation');
  assert.ok(lit(b, 'east', 'GREEN'), 'the remaining intersection still works');
});

// ------------------------------------------------------- static scenery

test('the street network is instanced: draw objects do not grow with the number of junctions', async () => {
  const { layoutNetwork } = await frontend('three/network.js');
  const { buildRoadNetwork, buildCity, disposeStatic } = await frontend('three/intersection.js');
  const ids = (n) => Array.from({ length: n }, (_, i) => ({ id: `ix-${i}` }));
  const small = layoutNetwork(ids(1), { spacing: SPACING });
  const large = layoutNetwork(ids(9), { spacing: SPACING });

  const objects = (layout) => {
    const g = buildRoadNetwork(layout);
    const c = buildCity(layout);
    const n = { roads: g.children.length, city: c.children.length };
    const boxes = g.children.filter((o) => o.isInstancedMesh)[2];
    disposeStatic(g);
    disposeStatic(c);
    return { ...n, junctionBoxes: boxes.count };
  };
  const a = objects(small);
  const b = objects(large);
  assert.equal(a.junctionBoxes, 4);
  assert.equal(b.junctionBoxes, 9);
  assert.equal(b.roads, a.roads, 'same number of road/marking/lamp objects');
  // At most: 5 building materials + roof plant + edge lines + tree crowns + trunks.
  assert.ok(a.city <= 9 && b.city <= 9, `building/tree objects stay constant (${a.city}, ${b.city})`);
});
