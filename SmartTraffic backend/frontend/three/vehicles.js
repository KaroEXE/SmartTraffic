import * as THREE from 'three';
import { DIRS, LAYOUT, OPPOSITE, approach, pathPoint, laneOffset } from './intersection.js';

/**
 * Visual traffic flow. Each approach has two lanes; each lane is an ordered
 * list (front-most first) with simple car-following:
 *   - stop for RED, and for YELLOW when the car can stop comfortably
 *   - never enter the junction while cross traffic is still inside it
 *   - never drive into a crosswalk with pedestrians on it
 *   - keep a minimum gap to the vehicle ahead (no overlap by construction)
 *
 * The number of vehicles queued/approaching follows the backend's
 * `traffic[dir].vehicles`, scaled and capped for readability.
 */

const VMAX = 11;
const EV_VMAX = 14;
const ACCEL = 3.5;
const DECEL = 6;
const MIN_GAP = 1.8;
const LANES = 2;
const MAX_PER_APPROACH = 14;
const VIS_SCALE = 0.75;

// ---------------------------------------------------------------- models

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.3, ...extra });

const BODY = [0xd8dbde, 0xa9afb6, 0x6d757e, 0x3c434b, 0x8a8478, 0x55606c, 0xb7b0a3, 0x2a2f35].map((c) => std(c));
const GLASS = std(0x14191e, { roughness: 0.15, metalness: 0.7 });
const TAIL = new THREE.MeshStandardMaterial({ color: 0x3a0806, emissive: 0xff2a1e, emissiveIntensity: 0.7 });
const HEAD = new THREE.MeshStandardMaterial({ color: 0xbfc5cc, emissive: 0xfff6e8, emissiveIntensity: 0.5 });
const WHITE = std(0xe6e9ec, { metalness: 0.15 });
const AMB_RED = std(0xc0262d, { metalness: 0.1 });
const POLICE_DARK = std(0x1c2531);
const FIRE_RED = std(0xa8231c, { metalness: 0.2 });
const LADDER = std(0xb9bec4, { metalness: 0.5 });

function box(w, h, l, mat, y, z = 0, shadow = false) {
  const geo = new THREE.BoxGeometry(w, h, l);
  geo.translate(0, y, z);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = shadow;
  return mesh;
}

// Geometry is cached per kind; materials are shared, so a vehicle costs a
// handful of draw calls and no allocations after warm-up.
const GEO_CACHE = new Map();
function cachedBox(key, w, h, l, y, z = 0) {
  if (!GEO_CACHE.has(key)) {
    const geo = new THREE.BoxGeometry(w, h, l);
    geo.translate(0, y, z);
    GEO_CACHE.set(key, geo);
  }
  return GEO_CACHE.get(key);
}
function part(key, dims, mat, shadow = false) {
  const mesh = new THREE.Mesh(cachedBox(key, ...dims), mat);
  mesh.castShadow = shadow;
  return mesh;
}

const KINDS = {
  car: { len: 4.4, build: (mat) => [
    part('car-body', [1.8, 0.62, 4.4, 0.52], mat, true),
    part('car-cabin', [1.58, 0.5, 2.2, 1.07, -0.25], GLASS),
    part('car-tail', [1.5, 0.12, 0.05, 0.62, -2.21], TAIL),
    part('car-head', [1.5, 0.1, 0.05, 0.6, 2.21], HEAD),
  ] },
  suv: { len: 4.8, build: (mat) => [
    part('suv-body', [1.92, 0.8, 4.8, 0.62], mat, true),
    part('suv-cabin', [1.72, 0.6, 2.9, 1.32, -0.3], GLASS),
    part('suv-tail', [1.6, 0.12, 0.05, 0.8, -2.41], TAIL),
  ] },
  van: { len: 5.6, build: (mat) => [
    part('van-body', [2.0, 1.95, 5.6, 1.2], WHITE, true),
    part('van-glass', [1.9, 0.55, 0.06, 1.55, 2.79], GLASS),
    part('van-tail', [1.8, 0.14, 0.05, 0.75, -2.81], TAIL),
  ] },
  bus: { len: 10.5, build: () => [
    part('bus-body', [2.5, 2.7, 10.5, 1.6], WHITE, true),
    part('bus-win', [2.54, 0.85, 9.6, 2.05, 0.1], GLASS),
    part('bus-tail', [2.2, 0.15, 0.05, 0.9, -5.26], TAIL),
  ] },
};

function pickKind() {
  const r = Math.random();
  if (r < 0.68) return 'car';
  if (r < 0.88) return 'suv';
  if (r < 0.96) return 'van';
  return 'bus';
}

function emergencyModel(type) {
  const lightA = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: 0xff2b22, emissiveIntensity: 0.1 });
  const lightB = new THREE.MeshStandardMaterial({
    color: 0x101010,
    emissive: type === 'police' ? 0x2f6bff : 0xffffff,
    emissiveIntensity: 0.1,
  });
  const g = new THREE.Group();
  let len;
  let roofY;

  if (type === 'police') {
    len = 4.7;
    roofY = 1.42;
    g.add(
      box(1.86, 0.64, 4.7, POLICE_DARK, 0.52, 0, true),
      box(1.88, 0.3, 2.0, WHITE, 0.6, 0.1),
      box(1.62, 0.5, 2.3, GLASS, 1.08, -0.25),
    );
  } else if (type === 'fire_truck') {
    len = 8.6;
    roofY = 2.95;
    g.add(
      box(2.45, 2.5, 8.6, FIRE_RED, 1.45, 0, true),
      box(2.3, 0.7, 2.0, GLASS, 2.1, 3.25),
      box(0.8, 0.22, 6.4, LADDER, 2.82, -0.9),
    );
  } else {
    len = 5.9;
    roofY = 2.55;
    g.add(
      box(2.1, 2.15, 5.9, WHITE, 1.35, 0, true),
      box(2.14, 0.24, 5.92, AMB_RED, 1.2),
      box(2.0, 0.6, 0.06, GLASS, 1.75, 2.96),
    );
  }
  const barZ = type === 'fire_truck' ? 3.6 : type === 'police' ? -0.2 : 2.3;
  // Two-segment light bar on the roof; halves alternate in update().
  [lightA, lightB].forEach((mat, i) => {
    const segment = box(0.7, 0.18, 0.32, mat, roofY, barZ);
    segment.position.x = i === 0 ? -0.36 : 0.36;
    g.add(segment);
  });
  return { group: g, len, lights: [lightA, lightB] };
}

// ------------------------------------------------------------------ system

export class VehicleSystem {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'vehicles';
    parent.add(this.group);

    this.lanes = {};
    this.targets = {};
    this.spawnTimers = {};
    this.signals = {};
    for (const dir of DIRS) {
      this.lanes[dir] = Array.from({ length: LANES }, () => []);
      this.targets[dir] = 0;
      this.spawnTimers[dir] = Math.random();
      this.signals[dir] = 'RED';
    }
    this.emergencyKey = null;
    this._tmp = { x: 0, z: 0 };
  }

  // ------------------------------------------------------------ inputs

  setSignals(signals) {
    for (const dir of DIRS) this.signals[dir] = signals[dir] || 'RED';
  }

  setDemand(traffic) {
    for (const dir of DIRS) {
      const n = traffic && traffic[dir] ? traffic[dir].vehicles : 0;
      this.targets[dir] = n > 0 ? Math.min(MAX_PER_APPROACH, Math.max(1, Math.round(n * VIS_SCALE))) : 0;
    }
  }

  setEmergency(em) {
    if (!em || !em.active || !em.direction) {
      this.emergencyKey = null;
      return;
    }
    const key = `${em.type}:${em.direction}`;
    if (key === this.emergencyKey) return;
    this.emergencyKey = key;
    // One vehicle per emergency: never add another while one of the same
    // type is still approaching on that side.
    if (!this._emergencyVehicleApproaching(em.direction, em.type)) this._spawnEmergency(em.type, em.direction);
  }

  _emergencyVehicleApproaching(dir, type) {
    return this.lanes[dir].some((lane) => lane.some((v) => v.ev && v.ev.type === type && !v.passed));
  }

  reset() {
    for (const dir of DIRS) {
      for (const lane of this.lanes[dir]) {
        for (const v of lane) this._dispose(v);
        lane.length = 0;
      }
    }
    this.emergencyKey = null;
  }

  /** Populate approaches immediately so a newly selected intersection is not empty. */
  prefill() {
    const { stopS } = approach('north');
    for (const dir of DIRS) {
      const green = this.signals[dir] === 'GREEN';
      const cursors = [stopS - (green ? 6 : 0), stopS - (green ? 12 : 0)];
      for (let k = 0; k < this.targets[dir]; k += 1) {
        const lane = k % LANES;
        const kind = pickKind();
        const len = KINDS[kind].len;
        const s = cursors[lane] - len / 2;
        if (s - len / 2 < 2) continue;
        cursors[lane] = s - len / 2 - (green ? 9 + Math.random() * 8 : MIN_GAP + 0.3);
        const v = this._create(dir, lane, kind, s, green ? VMAX * 0.8 : 0);
        this.lanes[dir][lane].push(v);
      }
    }
  }

  countOnApproach(dir) {
    let n = 0;
    for (const lane of this.lanes[dir]) for (const v of lane) if (!v.passed) n += 1;
    return n;
  }

  // ---------------------------------------------------------- creation

  _create(dir, lane, kind, s, speed) {
    const model = KINDS[kind];
    const group = new THREE.Group();
    const mat = BODY[Math.floor(Math.random() * BODY.length)];
    for (const mesh of model.build(mat)) group.add(mesh);
    group.rotation.y = approach(dir).heading;
    this.group.add(group);
    const v = { group, dir, lane, s, v: speed, len: model.len, vmax: VMAX * (0.92 + Math.random() * 0.1), passed: false, ev: null };
    this._place(v);
    return v;
  }

  _spawnEmergency(type, dir) {
    // Use the lane with the shorter queue so the vehicle reaches the junction sooner.
    const queued = (lane) => this.lanes[dir][lane].filter((v) => !v.passed).length;
    const laneIdx = queued(1) < queued(0) ? 1 : 0;
    const lane = this.lanes[dir][laneIdx];
    const model = emergencyModel(type);
    let s = 0;
    const last = lane[lane.length - 1];
    if (last) s = Math.min(s, last.s - last.len / 2 - MIN_GAP - model.len / 2);

    model.group.rotation.y = approach(dir).heading;
    this.group.add(model.group);
    const v = {
      group: model.group, dir, lane: laneIdx, s, v: EV_VMAX * 0.9, len: model.len,
      vmax: EV_VMAX, passed: false, ev: { id: `${type}-${dir}-${Date.now()}`, lights: model.lights, type },
    };
    this._place(v);
    lane.push(v);
  }

  _dispose(v) {
    this.group.remove(v.group);
    if (v.ev) {
      v.ev.lights.forEach((m) => m.dispose());
      v.group.traverse((o) => o.geometry && o.geometry.dispose());
    }
  }

  _place(v) {
    const p = pathPoint(v.dir, v.s, laneOffset(v.lane), this._tmp);
    v.group.position.set(p.x, 0, p.z);
  }

  _spawn(dt) {
    for (const dir of DIRS) {
      this.spawnTimers[dir] -= dt;
      if (this.spawnTimers[dir] > 0) continue;

      let pending = 0;
      let evLane = -1;
      for (let l = 0; l < LANES; l += 1) {
        for (const v of this.lanes[dir][l]) {
          if (v.passed) continue;
          if (v.ev) evLane = l;
          else pending += 1;
        }
      }
      if (pending >= this.targets[dir]) continue;

      const kind = pickKind();
      const len = KINDS[kind].len;
      let best = -1;
      let bestCount = Infinity;
      for (let l = 0; l < LANES; l += 1) {
        if (l === evLane) continue;
        const lane = this.lanes[dir][l];
        const last = lane[lane.length - 1];
        if (last && last.s - last.len / 2 - MIN_GAP < len) continue;
        const count = lane.filter((v) => !v.passed).length;
        if (count < bestCount) {
          bestCount = count;
          best = l;
        }
      }
      if (best < 0) continue;

      const lane = this.lanes[dir][best];
      const last = lane[lane.length - 1];
      const speed = last ? Math.min(VMAX * 0.9, last.v) : VMAX * 0.9;
      lane.push(this._create(dir, best, kind, len / 2, speed));
      this.spawnTimers[dir] = 0.45 + Math.random() * 0.75;
    }
  }

  // ------------------------------------------------------------ update

  update(dt, time, isCrosswalkBusy) {
    const { roadLength, crosswalkInner, crosswalkOuter } = LAYOUT;
    const { stopS, length: pathLength } = approach('north');
    const boxEnd = roadLength + crosswalkOuter;
    const exitCrosswalk = roadLength + crosswalkInner - 0.6;

    // Which approaches currently have a vehicle inside the conflict area?
    const inBox = {};
    for (const dir of DIRS) {
      inBox[dir] = false;
      for (const lane of this.lanes[dir]) {
        for (const v of lane) {
          const front = v.s + v.len / 2;
          const rear = v.s - v.len / 2;
          if (front > stopS && rear < boxEnd) inBox[dir] = true;
        }
      }
    }

    for (const dir of DIRS) {
      const signal = this.signals[dir];
      const crossTrafficInside = DIRS.some((d) => d !== dir && inBox[d]);
      const pedsBlocking = isCrosswalkBusy(dir) || isCrosswalkBusy(OPPOSITE[dir]);

      for (const lane of this.lanes[dir]) {
        for (let i = 0; i < lane.length; i += 1) {
          const v = lane[i];
          const front = v.s + v.len / 2;
          let room = Infinity;

          if (i > 0) {
            const lead = lane[i - 1];
            room = lead.s - lead.len / 2 - MIN_GAP - front;
          }

          if (!v.passed) {
            const dist = stopS - front;
            if (dist < -0.01) {
              // Front is over the line: committed, clears the junction regardless of signal.
              v.passed = true;
            } else {
              let stop = signal === 'RED';
              if (signal === 'YELLOW') stop = dist > (v.v * v.v) / (2 * DECEL) + 0.5;
              if (!stop && (crossTrafficInside || pedsBlocking)) stop = true;
              if (stop) room = Math.min(room, dist);
            }
          } else if (front < exitCrosswalk && isCrosswalkBusy(OPPOSITE[dir])) {
            room = Math.min(room, exitCrosswalk - front);
          }

          const target = room === Infinity
            ? v.vmax
            : Math.min(v.vmax, Math.sqrt(2 * DECEL * Math.max(0, room - 0.15)));
          v.v = v.v < target ? Math.min(target, v.v + ACCEL * dt) : target;

          let move = v.v * dt;
          if (room !== Infinity) move = Math.min(move, Math.max(0, room));
          v.s += move;
          if (!v.passed && v.s + v.len / 2 > stopS + 0.01) v.passed = true;
          this._place(v);

          if (v.ev) {
            const on = Math.floor(time * 3) % 2 === 0;
            v.ev.lights[0].emissiveIntensity = on ? 3 : 0.08;
            v.ev.lights[1].emissiveIntensity = on ? 0.08 : 3;
          }
        }

        while (lane.length && lane[0].s - lane[0].len / 2 > pathLength) {
          this._dispose(lane.shift());
        }
      }
    }

    this._spawn(dt);
  }
}
