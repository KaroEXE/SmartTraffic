import * as THREE from 'three';
import { DIRS, LAYOUT, approach, legVector } from './intersection.js';

/**
 * Signal assemblies for each approach of ONE intersection: a mast-arm head
 * over the inbound lanes, a secondary head on the pole, a pedestrian head,
 * a thin state bar on the road behind the stop line (readable from any
 * camera angle), and a beacon above the mast arm that keeps the same size
 * on screen, so the signal stays readable from the network overview.
 *
 * Every instance owns its lamp materials: the scene creates one per
 * intersection, so setting one intersection's state never changes another.
 * Geometry is shared by all instances.
 *
 * Purely a renderer of backend state - no timing logic lives here. Until
 * the first state arrives (setState(null)) the lamps are dark: no colour is
 * shown that the backend did not send.
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
  UNKNOWN: new THREE.Color(0x3a4048),
};

export const SIGNAL_STATES = ['RED', 'YELLOW', 'GREEN'];

const housingMat = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.7 });
const backplateMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9 });
const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a616a, roughness: 0.5, metalness: 0.4 });

const ARM_LEN = 6.2;
const housingGeo = new THREE.BoxGeometry(0.55, 1.55, 0.42);
const backplateGeo = new THREE.BoxGeometry(0.9, 1.95, 0.05);
const lampGeo = new THREE.SphereGeometry(0.17, 14, 10);
const pedGeo = new THREE.BoxGeometry(0.42, 0.5, 0.26);
const pedFaceGeo = new THREE.PlaneGeometry(0.32, 0.38);
const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 6.6, 8);
const armGeo = new THREE.BoxGeometry(0.14, 0.14, ARM_LEN);
const barGeo = new THREE.PlaneGeometry(LAYOUT.roadHalf - 0.4, 0.55);

// Beacon: a soft round dot, generated in code (no image asset).
const BEACON_SIZE = 0.014; // fraction of the view, see THREE.Sprite sizeAttenuation
const BEACON_HEIGHT = 9.5;
const beaconTexture = (() => {
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      let a = 0;
      if (d < 0.5) a = 1;
      else if (d < 0.62) a = 1 - ((d - 0.5) / 0.12) * 0.7;
      else if (d < 1) a = 0.3 * ((1 - d) / 0.38) ** 2;
      const i = (y * n + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
})();

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
    this.parent = parent;
    this.group = new THREE.Group();
    this.group.name = 'traffic-lights';
    parent.add(this.group);
    this.units = {};
    this.known = false;
    this.signals = { north: null, south: null, east: null, west: null };
    this.pedSignals = { north: 'DONT_WALK', south: 'DONT_WALK', east: 'DONT_WALK', west: 'DONT_WALK' };
    this.beaconOpacity = 0;

    for (const dir of DIRS) this.units[dir] = this._buildUnit(dir);
    this.setState(null);
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
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.copy(base).add(new THREE.Vector3(0, 3.3, 0));
    pole.castShadow = true;
    unit.add(pole);

    // Mast arm reaching over the inbound lanes.
    const arm = new THREE.Mesh(armGeo, poleMat);
    arm.rotation.y = Math.atan2(-a.r.x, -a.r.z);
    arm.position.set(base.x - a.r.x * ARM_LEN / 2, base.y + 6.3, base.z - a.r.z * ARM_LEN / 2);
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
    const barMat = new THREE.MeshBasicMaterial({ color: BAR_COLORS.UNKNOWN.clone(), transparent: true, opacity: 0.9, toneMapped: false });
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = Math.atan2(-a.r.z, a.r.x); // long side runs across the lanes
    const barDist = stopLine + 0.75;
    bar.position.set(
      leg.x * barDist + a.r.x * roadHalf / 2,
      0.02,
      leg.z * barDist + a.r.z * roadHalf / 2,
    );
    unit.add(bar);

    // Beacon above the overhead head: constant size on screen, faded in
    // only when the camera is far away (setBeaconOpacity).
    const beaconMat = new THREE.SpriteMaterial({
      map: beaconTexture,
      color: BAR_COLORS.UNKNOWN.clone(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: false,
      toneMapped: false,
    });
    const beacon = new THREE.Sprite(beaconMat);
    beacon.scale.setScalar(BEACON_SIZE);
    beacon.position.set(overhead.position.x, BEACON_HEIGHT, overhead.position.z);
    beacon.visible = false;
    unit.add(beacon);

    this.group.add(unit);
    return { mats, pedMat, barMat, beaconMat, beacon };
  }

  /**
   * `signals`: { north: 'RED' | 'YELLOW' | 'GREEN', ... } from the backend,
   * or null when this intersection has no state yet (lamps dark).
   */
  setState(signals = {}, pedSignals = {}) {
    this.known = Boolean(signals);
    for (const dir of DIRS) {
      const unit = this.units[dir];
      if (!signals) {
        this.signals[dir] = null;
        for (const s of SIGNAL_STATES) setLamp(unit.mats[s], COLORS[s], false);
        unit.barMat.color.copy(BAR_COLORS.UNKNOWN);
        unit.beaconMat.color.copy(BAR_COLORS.UNKNOWN);
        this.pedSignals[dir] = 'DONT_WALK';
        continue;
      }
      const state = SIGNAL_STATES.includes(signals[dir]) ? signals[dir] : 'RED';
      this.signals[dir] = state;
      for (const s of SIGNAL_STATES) setLamp(unit.mats[s], COLORS[s], state === s);
      unit.barMat.color.copy(BAR_COLORS[state]);
      unit.beaconMat.color.copy(BAR_COLORS[state]);
      this.pedSignals[dir] = (pedSignals && pedSignals[dir]) || 'DONT_WALK';
    }
    this._applyBeacons();
    this._applyPed(0);
  }

  /** 0 (hidden, close-up) .. 1 (fully shown, overview). */
  setBeaconOpacity(opacity) {
    const o = Math.max(0, Math.min(1, opacity));
    if (Math.abs(o - this.beaconOpacity) < 0.01) return;
    this.beaconOpacity = o;
    this._applyBeacons();
  }

  _applyBeacons() {
    const visible = this.known && this.beaconOpacity > 0.01;
    for (const dir of DIRS) {
      const unit = this.units[dir];
      unit.beacon.visible = visible;
      unit.beaconMat.opacity = this.beaconOpacity;
    }
  }

  _applyPed(time) {
    const blinkOn = Math.floor(time * 2) % 2 === 0;
    for (const dir of DIRS) {
      const mat = this.units[dir].pedMat;
      const state = this.pedSignals[dir];
      if (!this.known) {
        mat.emissive.copy(COLORS.DONT_WALK);
        mat.emissiveIntensity = 0.05;
      } else if (state === 'WALK') {
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

  /** Removes this intersection's signals and frees the materials it owns. */
  dispose() {
    this.parent.remove(this.group);
    for (const dir of DIRS) {
      const unit = this.units[dir];
      for (const s of SIGNAL_STATES) unit.mats[s].dispose();
      unit.pedMat.dispose();
      unit.barMat.dispose();
      unit.beaconMat.dispose();
    }
  }
}
