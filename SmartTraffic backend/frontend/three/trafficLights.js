import * as THREE from 'three';
import { DIRS, LAYOUT, approach, legVector } from './intersection.js';

/**
 * Signal assemblies for each approach: a mast-arm head over the inbound
 * lanes, a secondary head on the pole, a pedestrian head, and a thin state
 * bar on the road behind the stop line (readable from any camera angle).
 *
 * Purely a renderer of backend state - no timing logic lives here.
 */

const COLORS = {
  RED: new THREE.Color(0xff3b36),
  YELLOW: new THREE.Color(0xffb52e),
  GREEN: new THREE.Color(0x2fe070),
  OFF: new THREE.Color(0x15181b),
  WALK: new THREE.Color(0xe8edf1),
  DONT_WALK: new THREE.Color(0xf08c2e),
};

const BAR_COLORS = {
  RED: new THREE.Color(0xe5484d),
  YELLOW: new THREE.Color(0xf2b632),
  GREEN: new THREE.Color(0x2fd06b),
};

const housingMat = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.7 });
const backplateMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9 });
const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a616a, roughness: 0.5, metalness: 0.4 });

const housingGeo = new THREE.BoxGeometry(0.55, 1.55, 0.42);
const backplateGeo = new THREE.BoxGeometry(0.9, 1.95, 0.05);
const lampGeo = new THREE.SphereGeometry(0.17, 14, 10);
const pedGeo = new THREE.BoxGeometry(0.42, 0.5, 0.26);
const pedFaceGeo = new THREE.PlaneGeometry(0.32, 0.38);

function lampMaterial() {
  return new THREE.MeshStandardMaterial({
    color: COLORS.OFF.clone(),
    emissive: COLORS.OFF.clone(),
    emissiveIntensity: 0,
    roughness: 0.3,
  });
}

function setLamp(mat, color, on) {
  if (on) {
    mat.color.copy(color);
    mat.emissive.copy(color);
    mat.emissiveIntensity = 2.6;
  } else {
    mat.color.copy(COLORS.OFF);
    mat.emissive.copy(color);
    mat.emissiveIntensity = 0.05;
  }
}

function buildHead(mats) {
  const head = new THREE.Group();
  const back = new THREE.Mesh(backplateGeo, backplateMat);
  back.position.z = -0.23;
  const housing = new THREE.Mesh(housingGeo, housingMat);
  housing.castShadow = true;
  head.add(back, housing);
  [mats.RED, mats.YELLOW, mats.GREEN].forEach((mat, i) => {
    const lamp = new THREE.Mesh(lampGeo, mat);
    lamp.position.set(0, 0.48 - i * 0.48, 0.17);
    lamp.scale.z = 0.6;
    head.add(lamp);
  });
  return head;
}

export class TrafficLights {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'traffic-lights';
    parent.add(this.group);
    this.units = {};
    this.signals = { north: 'RED', south: 'RED', east: 'RED', west: 'RED' };
    this.pedSignals = { north: 'DONT_WALK', south: 'DONT_WALK', east: 'DONT_WALK', west: 'DONT_WALK' };

    for (const dir of DIRS) this.units[dir] = this._buildUnit(dir);
    this.setState(this.signals, this.pedSignals);
  }

  _buildUnit(dir) {
    const { roadHalf, stopLine } = LAYOUT;
    const a = approach(dir);
    const leg = legVector(dir);
    const unit = new THREE.Group();

    const mats = { RED: lampMaterial(), YELLOW: lampMaterial(), GREEN: lampMaterial() };

    // Pole on the right-hand corner, just behind the stop line.
    const base = new THREE.Vector3(
      leg.x * (stopLine + 0.6) + a.r.x * (roadHalf + 1.0),
      0.15,
      leg.z * (stopLine + 0.6) + a.r.z * (roadHalf + 1.0),
    );
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 6.6, 8), poleMat);
    pole.position.copy(base).add(new THREE.Vector3(0, 3.3, 0));
    pole.castShadow = true;
    unit.add(pole);

    // Mast arm reaching over the inbound lanes.
    const armLen = 6.2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, armLen), poleMat);
    arm.rotation.y = Math.atan2(-a.r.x, -a.r.z);
    arm.position.set(base.x - a.r.x * armLen / 2, base.y + 6.3, base.z - a.r.z * armLen / 2);
    arm.castShadow = true;
    unit.add(arm);

    // Heads face oncoming traffic.
    const facing = Math.atan2(-a.f.x, -a.f.z);
    const overhead = buildHead(mats);
    overhead.position.set(base.x - a.r.x * 5.1, base.y + 5.35, base.z - a.r.z * 5.1);
    overhead.rotation.y = facing;
    unit.add(overhead);

    const poleHead = buildHead(mats);
    poleHead.scale.setScalar(0.8);
    poleHead.position.set(base.x - a.r.x * 0.35, base.y + 3.2, base.z - a.r.z * 0.35);
    poleHead.rotation.y = facing;
    unit.add(poleHead);

    // Pedestrian head facing across the crosswalk.
    const pedMat = new THREE.MeshStandardMaterial({ color: 0x15181b, emissive: COLORS.DONT_WALK.clone(), emissiveIntensity: 0.4 });
    const ped = new THREE.Group();
    const pedBox = new THREE.Mesh(pedGeo, housingMat);
    const pedFace = new THREE.Mesh(pedFaceGeo, pedMat);
    pedFace.position.z = 0.135;
    ped.add(pedBox, pedFace);
    ped.position.set(base.x + leg.x * -0.25, base.y + 2.3, base.z + leg.z * -0.25);
    ped.rotation.y = Math.atan2(-a.r.x, -a.r.z);
    unit.add(ped);

    // State bar across the inbound lanes, behind the stop line.
    const barMat = new THREE.MeshBasicMaterial({ color: BAR_COLORS.RED.clone(), transparent: true, opacity: 0.9, toneMapped: false });
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(roadHalf - 0.4, 0.55), barMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = Math.atan2(-a.r.z, a.r.x); // long side runs across the lanes
    const barDist = stopLine + 0.75;
    bar.position.set(
      leg.x * barDist + a.r.x * roadHalf / 2,
      0.02,
      leg.z * barDist + a.r.z * roadHalf / 2,
    );
    unit.add(bar);

    this.group.add(unit);
    return { mats, pedMat, barMat };
  }

  setState(signals = {}, pedSignals = {}) {
    for (const dir of DIRS) {
      const state = signals[dir] || 'RED';
      const unit = this.units[dir];
      this.signals[dir] = state;
      setLamp(unit.mats.RED, COLORS.RED, state === 'RED');
      setLamp(unit.mats.YELLOW, COLORS.YELLOW, state === 'YELLOW');
      setLamp(unit.mats.GREEN, COLORS.GREEN, state === 'GREEN');
      unit.barMat.color.copy(BAR_COLORS[state] || BAR_COLORS.RED);
      this.pedSignals[dir] = pedSignals[dir] || 'DONT_WALK';
    }
    this._applyPed(0);
  }

  _applyPed(time) {
    const blinkOn = Math.floor(time * 2) % 2 === 0;
    for (const dir of DIRS) {
      const mat = this.units[dir].pedMat;
      const state = this.pedSignals[dir];
      if (state === 'WALK') {
        mat.emissive.copy(COLORS.WALK);
        mat.emissiveIntensity = 1.8;
      } else if (state === 'CLEARANCE') {
        mat.emissive.copy(COLORS.DONT_WALK);
        mat.emissiveIntensity = blinkOn ? 1.6 : 0.05;
      } else {
        mat.emissive.copy(COLORS.DONT_WALK);
        mat.emissiveIntensity = 0.45;
      }
    }
  }

  update(time) {
    this._applyPed(time);
  }
}
