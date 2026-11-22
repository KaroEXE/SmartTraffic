const test = require('node:test');
const assert = require('node:assert/strict');

const { createTrafficDecisionService } = require('../services/trafficDecisionService');
const { validateTrafficPayload } = require('../utils/validation');

const config = {
  weights: { vehicles: 2, waiting: 3, queueLength: 2 },
  timing: {
    MIN_GREEN_TIME: 10,
    MAX_GREEN_TIME: 45,
    YELLOW_TIME: 3,
    ALL_RED_TIME: 1,
    SECONDS_PER_QUEUED_VEHICLE: 2,
    MAX_RED_TIME: 90,
    MIN_PEDESTRIAN_CROSSING_TIME: 10,
    PEDESTRIAN_CLEARANCE_TIME: 3,
    PEDESTRIAN_MAX_WAIT: 25,
    PEDESTRIAN_COOLDOWN: 20,
    EMERGENCY_MAX_HOLD_TIME: 90,
    PERCEPTION_HOLD_TIME: 3,
    DATA_TIMEOUT: 10,
    FALLBACK_GREEN_TIME: 20,
  },
  EMERGENCY_CONFIDENCE_THRESHOLD: 0.8,
};

function setup() {
  let t = 1_000_000;
  const svc = createTrafficDecisionService({
    intersections: [{ id: 'main', name: 'Main', lat: 0, lng: 0 }],
    config,
    now: () => t,
  });
  const advance = (seconds, { feed } = {}) => {
    for (let i = 0; i < seconds * 4; i += 1) {
      t += 250;
      if (feed && i % 4 === 0) svc.ingest(feed());
      svc.tick();
    }
  };
  return { svc, advance };
}

function payload({ traffic = {}, pedestrians = {}, emergency } = {}) {
  const base = { vehicles: 2, waiting: 2, queueLength: 1 };
  const body = {
    intersectionId: 'main',
    traffic: {
      north: { ...base, ...traffic.north },
      south: { ...base, ...traffic.south },
      east: { ...base, ...traffic.east },
      west: { ...base, ...traffic.west },
    },
    pedestrians,
    emergency: emergency || { detected: false, type: null, direction: null, confidence: 0 },
  };
  const result = validateTrafficPayload(body);
  assert.ok(result.ok, JSON.stringify(result.errors));
  return result.value;
}

test('validation rejects malformed payloads with useful messages', () => {
  const bad = validateTrafficPayload({ intersectionId: 'main', traffic: { north: { vehicles: -1 } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('traffic.north.vehicles')));
  assert.ok(bad.errors.some((e) => e.includes('traffic.south')));

  const badEmergency = validateTrafficPayload({
    ...payload(),
    emergency: { detected: true, type: 'tank', direction: 'up', confidence: 2 },
  });
  assert.equal(badEmergency.ok, false);
  assert.equal(badEmergency.errors.length, 3);
});

test('starts in fixed-time fallback and waits for AI data', () => {
  const { svc } = setup();
  const snap = svc.getSnapshot('main');
  assert.equal(snap.mode, 'FALLBACK');
  assert.equal(snap.aiStatus, 'WAITING');
  assert.equal(snap.signals.north, 'GREEN');
});

test('highest priority score wins after the current green', () => {
  const { svc, advance } = setup();
  const feed = () => payload({ traffic: { east: { vehicles: 20, waiting: 5, queueLength: 16 } } });
  svc.ingest(feed());
  assert.equal(svc.getSnapshot('main').mode, 'NORMAL');
  assert.equal(svc.getSnapshot('main').scores.east, 87);

  advance(30, { feed });
  const snap = svc.getSnapshot('main');
  assert.equal(snap.greenDirection, 'east');
  assert.deepEqual(snap.signals, { north: 'RED', south: 'RED', east: 'GREEN', west: 'RED' });
  assert.match(snap.reason, /EAST has the highest traffic demand/);
});

test('signals never show two non-red approaches at once', () => {
  const { svc, advance } = setup();
  let i = 0;
  const dirs = ['north', 'south', 'east', 'west'];
  const feed = () => {
    i += 1;
    const heavy = dirs[Math.floor(i / 20) % 4];
    return payload({ traffic: { [heavy]: { vehicles: 25, waiting: 30, queueLength: 20 } } });
  };
  for (let s = 0; s < 400; s += 1) {
    advance(1, { feed });
    const sig = svc.getSnapshot('main').signals;
    const active = Object.values(sig).filter((v) => v !== 'RED');
    assert.ok(active.length <= 1, `conflict: ${JSON.stringify(sig)}`);
  }
});

test('minimum and maximum green are enforced', () => {
  const { svc, advance } = setup();
  const feed = () => payload({ traffic: { north: { vehicles: 40, waiting: 1, queueLength: 40 }, south: { vehicles: 30, waiting: 1, queueLength: 30 } } });
  svc.ingest(feed());
  advance(25, { feed }); // fallback north green ends, adaptive takes over
  let greenStart = null;
  let longest = 0;
  let shortest = Infinity;
  let last = null;
  for (let s = 0; s < 300; s += 1) {
    advance(1, { feed });
    const snap = svc.getSnapshot('main');
    const g = snap.phase === 'GREEN' ? snap.greenDirection : null;
    if (g && g !== last) greenStart = s;
    if (!g && last && greenStart !== null) {
      const dur = s - greenStart;
      longest = Math.max(longest, dur);
      shortest = Math.min(shortest, dur);
    }
    last = g;
  }
  assert.ok(longest <= 46, `longest green ${longest}`);
  assert.ok(shortest >= 10, `shortest green ${shortest}`);
});

test('emergency preempts to the emergency approach and holds until cleared', () => {
  const { svc, advance } = setup();
  const normal = () => payload({ traffic: { east: { vehicles: 20, waiting: 5, queueLength: 16 } } });
  svc.ingest(normal());
  advance(30, { feed: normal });
  assert.equal(svc.getSnapshot('main').greenDirection, 'east');

  const ambulance = () => payload({
    traffic: { east: { vehicles: 20, waiting: 5, queueLength: 16 } },
    emergency: { detected: true, type: 'ambulance', direction: 'north', confidence: 0.94 },
  });
  svc.ingest(ambulance());
  let snap = svc.getSnapshot('main');
  assert.equal(snap.mode, 'EMERGENCY');
  assert.equal(snap.phase, 'YELLOW');
  assert.equal(snap.nextDirection, 'north');

  advance(5, { feed: ambulance });
  snap = svc.getSnapshot('main');
  assert.equal(snap.signals.north, 'GREEN');

  advance(60, { feed: ambulance });
  snap = svc.getSnapshot('main');
  assert.equal(snap.signals.north, 'GREEN', 'green is held past max green during emergency');
  assert.equal(snap.remaining, null);

  svc.ingest(normal());
  assert.equal(svc.getSnapshot('main').emergency.active, true, 'one missed frame does not clear it');
  advance(5, { feed: normal });
  snap = svc.getSnapshot('main');
  assert.equal(snap.mode, 'NORMAL');
  assert.equal(snap.emergency.active, false);
  assert.doesNotMatch(snap.reason, /held/);
});

test('a flickering emergency detection is confirmed once and stays active', () => {
  const { svc, advance } = setup();
  let flip = false;
  const feed = () => {
    flip = !flip;
    return flip
      ? payload({ emergency: { detected: true, type: 'ambulance', direction: 'north', confidence: 0.93 } })
      : payload();
  };
  let detections = 0;
  svc.on('systemEvent', (e) => { if (/detected NORTH/.test(e.message)) detections += 1; });
  svc.ingest(feed());
  for (let s = 0; s < 40; s += 1) {
    advance(1, { feed });
    assert.equal(svc.getSnapshot('main').emergency.active, true);
  }
  assert.equal(detections, 1, 'emergency confirmed once, not on every flicker');
});

test('a flickering pedestrian detection is still served', () => {
  const { svc, advance } = setup();
  let flip = false;
  const feed = () => {
    flip = !flip;
    return payload({ pedestrians: { south: flip } });
  };
  let requests = 0;
  svc.on('systemEvent', (e) => { if (e.category === 'PEDESTRIAN' && /crossing requested/.test(e.message)) requests += 1; });
  let walked = false;
  svc.ingest(feed());
  for (let s = 0; s < 60 && !walked; s += 1) {
    advance(1, { feed });
    if (svc.getSnapshot('main').phase === 'PED_WALK') walked = true;
  }
  assert.ok(walked, 'pedestrian request was served');
  assert.equal(requests, 1, 'one request, not one per flicker');
});

test('low-confidence emergency detections are ignored', () => {
  const { svc } = setup();
  svc.ingest(payload({ emergency: { detected: true, type: 'police', direction: 'east', confidence: 0.6 } }));
  const snap = svc.getSnapshot('main');
  assert.equal(snap.emergency.active, false);
  assert.equal(snap.emergency.candidate.direction, 'east');
  assert.notEqual(snap.mode, 'EMERGENCY');
});

test('pedestrian request gets an exclusive walk + clearance phase', () => {
  const { svc, advance } = setup();
  let ped = true;
  const feed = () => payload({ pedestrians: { south: ped } });
  svc.ingest(feed());
  let sawWalk = false;
  let sawClear = false;
  for (let s = 0; s < 60; s += 1) {
    advance(1, { feed });
    const snap = svc.getSnapshot('main');
    if (snap.phase === 'PED_WALK') {
      sawWalk = true;
      ped = false;
      assert.equal(snap.pedestrianSignals.south, 'WALK');
      assert.ok(Object.values(snap.signals).every((v) => v === 'RED'));
      assert.equal(snap.mode, 'PEDESTRIAN');
    }
    if (snap.phase === 'PED_CLEAR') sawClear = true;
  }
  assert.ok(sawWalk && sawClear);
  assert.equal(svc.getSnapshot('main').pedestrianSignals.south, 'DONT_WALK');
});

test('fairness guard serves a long-waiting low-volume approach', () => {
  const { svc, advance } = setup();
  const feed = () => payload({
    traffic: {
      north: { vehicles: 30, waiting: 0, queueLength: 30 },
      south: { vehicles: 30, waiting: 0, queueLength: 30 },
      east: { vehicles: 0, waiting: 0, queueLength: 0 },
      west: { vehicles: 1, waiting: 0, queueLength: 1 },
    },
  });
  svc.ingest(feed());
  let westServed = false;
  for (let s = 0; s < 200 && !westServed; s += 1) {
    advance(1, { feed });
    if (svc.getSnapshot('main').signals.west === 'GREEN') westServed = true;
  }
  assert.ok(westServed, 'west was starved');
});

test('stale data falls back to fixed-time plan and clears emergency', () => {
  const { svc, advance } = setup();
  svc.ingest(payload({ emergency: { detected: true, type: 'ambulance', direction: 'west', confidence: 0.9 } }));
  assert.equal(svc.getSnapshot('main').mode, 'EMERGENCY');
  advance(12);
  const snap = svc.getSnapshot('main');
  assert.equal(snap.aiStatus, 'STALE');
  assert.equal(snap.mode, 'FALLBACK');
  assert.equal(snap.emergency.active, false);
});
