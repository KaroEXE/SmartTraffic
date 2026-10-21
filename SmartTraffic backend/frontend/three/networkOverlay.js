import * as THREE from 'three';
import { LAYOUT } from './intersection.js';
import {
  corridorIndex, linkStates, siteState, vehiclePosition, corridorPath,
} from './networkView.js';

/**
 * The network layer of the 3D scene, drawn from the backend's topology and
 * its latest network decision (never from anything the scene invents):
 *
 *   road arrows  chevrons on every directed road of the topology, coloured
 *                by the queue at its far end (free / busy / congested /
 *                blocked / unknown) and moving while vehicles are being
 *                released onto it
 *   junction rings  normal / congested / signal action selected /
 *                emergency corridor / data unavailable
 *   corridor     the emergency vehicle, its direction, and a ribbon along
 *                its route through the corridor intersections - solid where
 *                green is being prepared or held, faint where only planned
 *   ETA chips    per corridor intersection: ETA, stage and status
 */

const LINK_COLOR = {
  free: new THREE.Color(0x7f9cbd),
  busy: new THREE.Color(0xd0d6dd),
  congested: new THREE.Color(0xf08c2e),
  blocked: new THREE.Color(0xe5484d),
  unknown: new THREE.Color(0x5f6872),
};
const RING = {
  normal: { color: 0x9aa1a9, opacity: 0.16, pulse: false },
  congested: { color: 0xf08c2e, opacity: 0.75, pulse: false },
  action: { color: 0x3987e5, opacity: 0.9, pulse: true },
  emergency: { color: 0xff453a, opacity: 0.95, pulse: true },
  stale: { color: 0x49515a, opacity: 0.4, pulse: false },
  nodata: { color: 0x49515a, opacity: 0.28, pulse: false },
};
const HEADING_ANGLE = { north: Math.PI, south: 0, east: Math.PI / 2, west: -Math.PI / 2 };
const HEADING_VEC = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const CHEVRONS_PER_LINK = 6;
const CHEVRON_SPEED = 7; // m/s while releasing
const EDGE = LAYOUT.crosswalkOuter + 6; // keep arrows off the junction box and crosswalks

function chevronGeometry() {
  // A solid dart, drawn pointing -y: rotateX(-90deg) maps -y to +z and keeps the face up.
  const s = new THREE.Shape();
  s.moveTo(0, -1.6);
  s.lineTo(1.5, 1.1);
  s.lineTo(0, 0.45);
  s.lineTo(-1.5, 1.1);
  s.closePath();
  const geo = new THREE.ShapeGeometry(s);
  geo.rotateX(-Math.PI / 2); // flat, face up, pointing +z
  return geo;
}

function ambulanceModel() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.5 });
  const red = new THREE.MeshStandardMaterial({ color: 0xc0262d, roughness: 0.5 });
  const lightA = new THREE.MeshBasicMaterial({ color: 0xff2b22, toneMapped: false });
  const lightB = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const box = (w, h, l, mat, y, z = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
    m.position.set(0, y, z);
    return m;
  };
  g.add(box(2.1, 2.1, 5.9, white, 1.35), box(2.14, 0.25, 5.92, red, 1.2));
  const a = box(0.7, 0.2, 0.34, lightA, 2.55, 2.3);
  a.position.x = -0.36;
  const b = box(0.7, 0.2, 0.34, lightB, 2.55, 2.3);
  b.position.x = 0.36;
  g.add(a, b);
  // Direction arrow floating above the vehicle (readable from the overview).
  const arrow = new THREE.Mesh(chevronGeometry(), new THREE.MeshBasicMaterial({ color: 0xff453a, toneMapped: false }));
  arrow.scale.setScalar(2.2);
  arrow.position.set(0, 7, 0);
  g.add(arrow);
  return { group: g, lights: [lightA, lightB] };
}

export class NetworkOverlay {
  constructor(parent, { tagLayer = null } = {}) {
    this.parent = parent;
    this.tagLayer = tagLayer;
    this.group = new THREE.Group();
    this.group.name = 'network-overlay';
    parent.add(this.group);
    this.chevronGeo = chevronGeometry();
    this.chevronMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false });
    this.ringGeo = new THREE.RingGeometry(18, 19.6, 56).rotateX(-Math.PI / 2);
    this.corridorMat = new THREE.MeshBasicMaterial({ color: 0xff453a, transparent: true, opacity: 0.75, toneMapped: false, depthWrite: false });
    this.plannedMat = new THREE.MeshBasicMaterial({ color: 0xff453a, transparent: true, opacity: 0.22, toneMapped: false, depthWrite: false });
    this.links = [];
    this.rings = new Map();
    this.sites = new Map();
    this.ribbons = [];
    this.chips = [];
    this.vehicles = new Map();
    this.decision = null;
    this.chevrons = null;
    this.scale = 1; // arrows grow with camera distance so the overview stays readable
  }

  /** (Re)builds arrows and rings for a layout and the backend topology. */
  setLayout(layout, topology) {
    this._clearLayout();
    this.sites = new Map(layout.sites.map((s) => [s.id, s]));
    for (const s of layout.sites) {
      const mat = new THREE.MeshBasicMaterial({ color: RING.nodata.color, transparent: true, opacity: RING.nodata.opacity, toneMapped: false, depthWrite: false });
      const ring = new THREE.Mesh(this.ringGeo, mat);
      ring.position.set(s.x, 0.05, s.z);
      ring.renderOrder = 2;
      this.group.add(ring);
      this.rings.set(s.id, { mesh: ring, mat, state: 'nodata' });
    }
    const links = ((topology && topology.links) || []).filter((l) => this.sites.has(l.from) && this.sites.has(l.to));
    this.links = links.map((l) => ({ ...l, state: 'unknown', releasing: false, offset: 0 }));
    const count = this.links.length * CHEVRONS_PER_LINK;
    if (count) {
      this.chevrons = new THREE.InstancedMesh(this.chevronGeo, this.chevronMat, count);
      this.chevrons.renderOrder = 3;
      this.chevrons.frustumCulled = false;
      for (let i = 0; i < count; i += 1) this.chevrons.setColorAt(i, LINK_COLOR.unknown);
      this.group.add(this.chevrons);
      this._placeChevrons(true);
    }
    if (this.decision) this.applyDecision(this.decision);
  }

  _placeChevrons(all) {
    if (!this.chevrons) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(this.scale, 1, this.scale);
    const up = new THREE.Vector3(0, 1, 0);
    // Wider arrows sit further apart so the two directions of a road never overlap.
    const lateral = LAYOUT.laneWidth * Math.max(1, this.scale * 0.6);
    this.links.forEach((l, li) => {
      if (!all && !l.releasing) return;
      const a = this.sites.get(l.from);
      const [hx, hz] = HEADING_VEC[l.heading];
      // Right-hand traffic: the travel lanes are to the right of the centre line.
      const rx = -hz;
      const rz = hx;
      const span = Math.hypot(this.sites.get(l.to).x - a.x, this.sites.get(l.to).z - a.z) - 2 * EDGE;
      const step = span / CHEVRONS_PER_LINK;
      q.setFromAxisAngle(up, HEADING_ANGLE[l.heading]);
      for (let k = 0; k < CHEVRONS_PER_LINK; k += 1) {
        const along = EDGE + ((k + 0.5) * step + l.offset) % span;
        p.set(a.x + hx * along + rx * lateral, 0.07, a.z + hz * along + rz * lateral);
        m.compose(p, q, s);
        this.chevrons.setMatrixAt(li * CHEVRONS_PER_LINK + k, m);
      }
    });
    this.chevrons.instanceMatrix.needsUpdate = true;
  }

  /** Draws one network decision. */
  applyDecision(decision) {
    this.decision = decision;
    if (!decision) return;
    const states = linkStates(decision);
    this.links.forEach((l, li) => {
      const st = states.get(l.id);
      l.state = st ? st.state : 'unknown';
      l.releasing = Boolean(st && st.releasing);
      for (let k = 0; k < CHEVRONS_PER_LINK; k += 1) this.chevrons.setColorAt(li * CHEVRONS_PER_LINK + k, LINK_COLOR[l.state]);
    });
    if (this.chevrons && this.chevrons.instanceColor) this.chevrons.instanceColor.needsUpdate = true;

    const corridors = corridorIndex(decision);
    const records = new Map((decision.intersections || []).map((r) => [r.intersectionId, r]));
    for (const [id, ring] of this.rings) {
      ring.state = siteState(records.get(id), corridors);
      ring.mat.color.setHex(RING[ring.state].color);
      ring.mat.opacity = RING[ring.state].opacity;
    }
    this._drawCorridors(decision.corridors || []);
  }

  _drawCorridors(corridors) {
    for (const r of this.ribbons) {
      this.group.remove(r);
      r.geometry.dispose();
    }
    this.ribbons = [];
    for (const chip of this.chips) chip.el.remove();
    this.chips = [];
    const seen = new Set();

    for (const c of corridors) {
      seen.add(c.vehicleId);
      const points = corridorPath(c, this.sites, LAYOUT.stopLine);
      const hasVehicle = Boolean(c.position && vehiclePosition(c.position, this.sites, LAYOUT.stopLine));
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.5) continue;
        const entry = c.entries[hasVehicle ? i : i + 1];
        const planned = !entry || entry.stage === 'planned' || entry.status === 'conflict';
        const geo = new THREE.PlaneGeometry(2.4, len).rotateX(-Math.PI / 2);
        const ribbon = new THREE.Mesh(geo, planned ? this.plannedMat : this.corridorMat);
        ribbon.position.set((a.x + b.x) / 2, 0.09, (a.z + b.z) / 2);
        ribbon.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
        ribbon.renderOrder = 4;
        this.group.add(ribbon);
        this.ribbons.push(ribbon);
      }

      if (this.tagLayer) {
        for (const e of c.entries) {
          const site = this.sites.get(e.intersectionId);
          if (!site) continue;
          const el = document.createElement('div');
          const confirmed = e.stage === 'preparing' || e.stage === 'holding';
          el.className = `corridor-chip st-${e.stage}${e.status !== 'ok' ? ` cs-${e.status}` : ''}${confirmed ? ' confirmed' : ''}`;
          const eta = e.etaSeconds !== null && e.etaSeconds !== undefined ? `ETA ${Math.round(e.etaSeconds)} s${e.etaEstimated ? ' (est.)' : ''}` : 'ETA --';
          el.textContent = `${c.type.toUpperCase()} · ${eta} · ${e.stage.toUpperCase()}${e.status !== 'ok' ? ` · ${e.status.replace('-', ' ').toUpperCase()}` : ''}`;
          el.title = e.reason || `${e.approach} approach ${confirmed ? '- signal action sent' : '- planned, no signal change yet'}`;
          this.tagLayer.appendChild(el);
          // Above the intersection label (16 m), so the two never overlap.
          this.chips.push({ el, anchor: new THREE.Vector3(site.x, 34, site.z) });
        }
      }

      let v = this.vehicles.get(c.vehicleId);
      const target = vehiclePosition(c.position, this.sites, LAYOUT.stopLine);
      if (!target) continue;
      if (!v) {
        const model = ambulanceModel();
        model.group.position.set(target.x, 0, target.z);
        this.group.add(model.group);
        v = { ...model, target: new THREE.Vector3(target.x, 0, target.z), heading: target.heading, speed: 0 };
        this.vehicles.set(c.vehicleId, v);
      }
      v.target.set(target.x, 0, target.z);
      v.heading = target.heading;
      v.speed = Number.isFinite(c.speedMps) ? c.speedMps : 12;
      v.group.rotation.y = HEADING_ANGLE[target.heading];
    }
    for (const [id, v] of this.vehicles) {
      if (seen.has(id)) continue;
      this.group.remove(v.group);
      v.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.vehicles.delete(id);
    }
  }

  /** Per-frame animation (released roads, pulses, vehicle motion). `distance` = camera to target. */
  update(dt, time, distance = 160) {
    const scale = Math.round(THREE.MathUtils.clamp(distance / 170, 1, 3.5) * 4) / 4;
    if (scale !== this.scale) {
      this.scale = scale;
      this._placeChevrons(true);
    }
    let moving = false;
    for (const l of this.links) {
      if (!l.releasing) continue;
      l.offset = (l.offset + CHEVRON_SPEED * dt) % 1000;
      moving = true;
    }
    if (moving) this._placeChevrons(false);
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(time * 2.4));
    for (const ring of this.rings.values()) {
      if (RING[ring.state].pulse) ring.mat.opacity = RING[ring.state].opacity * pulse;
    }
    this.corridorMat.opacity = 0.45 + 0.4 * pulse;
    const flash = Math.floor(time * 3) % 2 === 0;
    for (const v of this.vehicles.values()) {
      // Dead-reckon along the heading between decisions, then ease to the reported position.
      const [hx, hz] = HEADING_VEC[v.heading];
      v.target.x += hx * v.speed * dt;
      v.target.z += hz * v.speed * dt;
      v.group.position.lerp(v.target, Math.min(1, dt * 3));
      v.lights[0].color.setHex(flash ? 0xff2b22 : 0x300000);
      v.lights[1].color.setHex(flash ? 0x202020 : 0xffffff);
    }
  }

  _clearLayout() {
    for (const ring of this.rings.values()) {
      this.group.remove(ring.mesh);
      ring.mat.dispose();
    }
    this.rings.clear();
    if (this.chevrons) {
      this.group.remove(this.chevrons);
      this.chevrons.dispose();
      this.chevrons = null;
    }
    this.links = [];
    this._drawCorridors([]);
  }

  dispose() {
    this._clearLayout();
    this.parent.remove(this.group);
    this.chevronGeo.dispose();
    this.ringGeo.dispose();
    this.chevronMat.dispose();
    this.corridorMat.dispose();
    this.plannedMat.dispose();
  }
}
