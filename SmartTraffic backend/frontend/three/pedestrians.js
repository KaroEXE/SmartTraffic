import * as THREE from 'three';
import { DIRS, LAYOUT, legVector } from './intersection.js';

/**
 * Pedestrians at the four crosswalks.
 *   request active + DONT_WALK -> a few people wait at the kerb
 *   WALK                       -> they cross (plus a few more)
 *   CLEARANCE                  -> nobody new starts; people on the road hurry
 * `isCrosswalkBusy(dir)` lets vehicles respect people still on the road.
 */

const WALK_SPEED = [1.45, 1.75];
const CLEAR_SPEED = 2.2;

const bodyGeo = new THREE.CylinderGeometry(0.17, 0.21, 1.05, 8);
bodyGeo.translate(0, 0.62, 0);
const headGeo = new THREE.SphereGeometry(0.15, 10, 8);
headGeo.translate(0, 1.33, 0);

const CLOTHES = [0x8d96a0, 0x5e6873, 0xb9b3a8, 0x3f4851, 0x9c8f7c, 0xc7ccd1].map(
  (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 }),
);
const SKIN = new THREE.MeshStandardMaterial({ color: 0xc9b29b, roughness: 0.9 });

function crosswalkGeometry(dir) {
  const { crosswalkInner, crosswalkOuter, roadHalf } = LAYOUT;
  const u = legVector(dir);
  const a = { x: -u.z, z: u.x };
  const mid = (crosswalkInner + crosswalkOuter) / 2;
  return {
    u,
    a,
    cx: u.x * mid,
    cz: u.z * mid,
    half: roadHalf + 1.6,
    width: (crosswalkOuter - crosswalkInner) / 2 - 0.35,
  };
}

export class PedestrianSystem {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'pedestrians';
    parent.add(this.group);
    this.cw = {};
    this.people = {};
    this.signal = {};
    for (const dir of DIRS) {
      this.cw[dir] = crosswalkGeometry(dir);
      this.people[dir] = [];
      this.signal[dir] = 'DONT_WALK';
    }
  }

  reset() {
    for (const dir of DIRS) {
      for (const p of this.people[dir]) this.group.remove(p.group);
      this.people[dir] = [];
      this.signal[dir] = 'DONT_WALK';
    }
  }

  setState(pedSignals = {}, requests = {}) {
    for (const dir of DIRS) {
      const prev = this.signal[dir];
      const cur = pedSignals[dir] || 'DONT_WALK';
      this.signal[dir] = cur;
      const list = this.people[dir];

      if (cur === 'WALK' && prev !== 'WALK') {
        for (const p of list) {
          if (p.state === 'waiting') {
            p.state = 'walking';
            p.delay = Math.random() * 1.0;
          }
        }
        const extra = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < extra; i += 1) list.push(this._create(dir, 'walking', Math.random() * 1.6));
      } else if (cur === 'CLEARANCE') {
        for (const p of list) {
          if (p.state === 'walking' && p.t <= 0) p.state = 'leaving';
        }
      } else if (cur === 'DONT_WALK') {
        const waiting = list.filter((p) => p.state === 'waiting');
        if (requests[dir]) {
          for (let i = waiting.length; i < 3; i += 1) list.push(this._create(dir, 'waiting', 0));
        } else {
          for (const p of waiting) p.state = 'leaving';
        }
      }
    }
  }

  isCrosswalkBusy(dir) {
    const limit = LAYOUT.roadHalf + 0.4;
    for (const p of this.people[dir]) {
      if (p.state !== 'walking' || p.delay > 0) continue;
      const along = -this.cw[dir].half + p.t;
      if (Math.abs(along) < limit) return true;
    }
    return false;
  }

  _create(dir, state, delay) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, CLOTHES[Math.floor(Math.random() * CLOTHES.length)]);
    body.castShadow = true;
    group.add(body, new THREE.Mesh(headGeo, SKIN));
    // Slightly over-scaled so people stay legible from the default camera.
    group.scale.setScalar(1.3 + Math.random() * 0.15);
    this.group.add(group);
    const cw = this.cw[dir];
    const p = {
      group,
      side: Math.random() < 0.5 ? 1 : -1,
      lateral: (Math.random() * 2 - 1) * cw.width,
      t: state === 'waiting' ? -Math.random() * 1.2 : 0,
      speed: WALK_SPEED[0] + Math.random() * (WALK_SPEED[1] - WALK_SPEED[0]),
      state,
      delay,
      leave: 0,
      phase: Math.random() * Math.PI * 2,
    };
    this._place(dir, p, 0);
    return p;
  }

  _place(dir, p, time) {
    const cw = this.cw[dir];
    const along = p.side * (-cw.half + p.t);
    const out = p.lateral + p.leave;
    const x = cw.cx + cw.a.x * along + cw.u.x * out;
    const z = cw.cz + cw.a.z * along + cw.u.z * out;
    const onKerb = Math.abs(along) > LAYOUT.roadHalf;
    const moving = p.state === 'walking' && p.delay <= 0;
    p.group.position.set(x, (onKerb ? 0.15 : 0) + (moving ? Math.abs(Math.sin(time * 7 + p.phase)) * 0.05 : 0), z);

    // Face direction of travel
    const dx = p.leave > 0 ? cw.u.x : cw.a.x * p.side;
    const dz = p.leave > 0 ? cw.u.z : cw.a.z * p.side;
    p.group.rotation.y = Math.atan2(dx, dz);
  }

  update(dt, time) {
    for (const dir of DIRS) {
      const cw = this.cw[dir];
      const list = this.people[dir];
      const clearing = this.signal[dir] === 'CLEARANCE';

      for (const p of list) {
        if (p.state === 'walking') {
          if (p.delay > 0) {
            p.delay -= dt;
          } else {
            p.t += (clearing ? Math.max(p.speed, CLEAR_SPEED) : p.speed) * dt;
            if (p.t >= cw.half * 2) {
              p.t = cw.half * 2;
              p.state = 'leaving';
            }
          }
        } else if (p.state === 'leaving') {
          p.leave += p.speed * dt;
          if (p.leave > 6) p.state = 'gone';
        }
        if (p.state !== 'gone') this._place(dir, p, time);
      }

      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].state === 'gone') {
          this.group.remove(list[i].group);
          list.splice(i, 1);
        }
      }
    }
  }
}
