import * as THREE from 'three';

/**
 * Static geometry for the street network (every junction is the same
 * four-way intersection) plus the shared layout and path helpers used by
 * vehicles, pedestrians and signals.
 *
 * World axes: +x = east, -z = north, +y = up. Units are metres.
 * Right-hand traffic, two inbound + two outbound lanes per leg.
 * Layout and path helpers are local to one junction (centre at 0, 0); each
 * intersection's dynamic objects live in a group placed at its junction.
 */

export const DIRS = ['north', 'south', 'east', 'west'];

export const LAYOUT = {
  laneWidth: 3.5,
  roadHalf: 7,            // 2 lanes each way
  sidewalk: 4.5,
  crosswalkInner: 8.5,
  crosswalkOuter: 11.5,
  stopLine: 13,           // distance of stop line from centre
  roadLength: 100,        // length of each leg from centre
};

// Unit vector pointing from the centre out along each leg.
const LEG = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
};

export const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east' };

export function legVector(dir) {
  return LEG[dir];
}

/** Travel geometry for vehicles approaching FROM `dir`. */
export function approach(dir) {
  const leg = LEG[dir];
  const f = { x: -leg.x, z: -leg.z };          // travel direction
  const r = { x: -f.z, z: f.x };               // right-hand side of travel
  return {
    f,
    r,
    start: { x: leg.x * LAYOUT.roadLength, z: leg.z * LAYOUT.roadLength },
    heading: Math.atan2(f.x, f.z),
    stopS: LAYOUT.roadLength - LAYOUT.stopLine,
    length: LAYOUT.roadLength * 2,
  };
}

/** World position at distance `s` along the approach path, offset `lateral` to the right. */
export function pathPoint(dir, s, lateral, out = { x: 0, z: 0 }) {
  const a = approach(dir);
  out.x = a.start.x + a.f.x * s + a.r.x * lateral;
  out.z = a.start.z + a.f.z * s + a.r.z * lateral;
  return out;
}

export function laneOffset(lane) {
  return LAYOUT.laneWidth * (lane + 0.5);
}

// ------------------------------------------------------------------ helpers

export function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i += 1) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

/** A flat plane geometry lying on the ground (normal +y). */
function groundPlane(w, d) {
  const geo = new THREE.PlaneGeometry(w, d);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * One InstancedMesh for many copies of `geo`: items are { x, y, z, rotY?, sx?, sy?, sz? }.
 * Static scenery is drawn this way so the draw-call count does not grow
 * with the number of junctions.
 */
function instanced(geo, material, items, { receive = true, cast = false } = {}) {
  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, items.length));
  mesh.count = items.length;
  items.forEach((it, i) => {
    _p.set(it.x, it.y || 0, it.z);
    _q.setFromAxisAngle(_UP, it.rotY || 0);
    _s.set(it.sx || 1, it.sy || 1, it.sz || 1);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  });
  mesh.receiveShadow = receive;
  mesh.castShadow = cast;
  mesh.computeBoundingSphere();
  return mesh;
}

/** Many thin flat rectangles as one InstancedMesh (lane dashes, zebra stripes). */
function stripes(rects, material, y) {
  return instanced(groundPlane(1, 1), material, rects.map((r) => ({ x: r.x, y, z: r.z, sx: r.w, sz: r.d })));
}

/** Releases the GPU resources of a group built here (materials are shared and kept). */
export function disposeStatic(group) {
  group.traverse((o) => {
    if (o.isInstancedMesh) o.dispose();
    if (o.geometry) o.geometry.dispose();
  });
}

// ------------------------------------------------------------ materials

const MAT = {
  ground: new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 1 }),
  road: new THREE.MeshStandardMaterial({ color: 0x2b2f34, roughness: 0.95 }),
  box: new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.95 }),
  sidewalk: new THREE.MeshStandardMaterial({ color: 0x484e55, roughness: 0.9 }),
  lot: new THREE.MeshStandardMaterial({ color: 0x1e2226, roughness: 1 }),
  marking: new THREE.MeshStandardMaterial({ color: 0xc9cdd1, roughness: 0.8 }),
  markingDim: new THREE.MeshStandardMaterial({ color: 0x8b9096, roughness: 0.8 }),
  pole: new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.6, metalness: 0.3 }),
  lampHead: new THREE.MeshStandardMaterial({ color: 0xdfe4ea, emissive: 0xfff3dc, emissiveIntensity: 0.6 }),
  // Massing-model look: muted concrete greys, outlined edges.
  building: [0x5b6168, 0x646a72, 0x6d737b, 0x555b62, 0x727880].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0.0 }),
  ),
  roof: new THREE.MeshStandardMaterial({ color: 0x4a5057, roughness: 0.9 }),
  edges: new THREE.LineBasicMaterial({ color: 0x9aa1a9, transparent: true, opacity: 0.28 }),
  tree: new THREE.MeshStandardMaterial({ color: 0x2f3a33, roughness: 1, flatShading: true }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x3a342e, roughness: 1 }),
};

const CURB_H = 0.15;
// Roads leaving the network at its edge run on this far before the fog takes them.
const OUTER_ROAD = 420;

// --------------------------------------------------------- static scene

/**
 * Roads, kerbs, markings and street lighting for every junction of a
 * network layout (three/network.js), in world coordinates. Each junction is
 * the same four-way intersection the scene has always drawn, centred on its
 * slot; with the layout's spacing (2 x roadLength) the legs of neighbours
 * meet half-way, so the result is one continuous street grid. Roads at the
 * edge of the network continue outward.
 */
export function buildRoadNetwork(layout) {
  const g = new THREE.Group();
  g.name = 'road-network';
  const { roadHalf, roadLength, sidewalk, crosswalkInner, crosswalkOuter, stopLine, laneWidth } = LAYOUT;
  const width = roadHalf * 2;
  const slots = layout.slots;
  const { bounds } = layout;

  // Ground, large enough that its edge is always lost in the fog.
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const groundSize = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + 2 * (roadLength + OUTER_ROAD) + 1600;
  const ground = new THREE.Mesh(groundPlane(groundSize, groundSize), MAT.ground);
  ground.position.set(cx, -0.02, cz);
  ground.receiveShadow = true;
  g.add(ground);

  // Roads: N-S strip full length, E-W legs either side, centre box.
  const half = roadLength - roadHalf;
  const at = (x, z, y = 0) => ({ x, y, z });
  g.add(instanced(groundPlane(width, roadLength * 2), MAT.road, slots.map((o) => at(o.x, o.z))));
  g.add(instanced(groundPlane(half, width), MAT.road, slots.flatMap((o) => [
    at(o.x + (roadLength + roadHalf) / 2, o.z, 0.001), at(o.x - (roadLength + roadHalf) / 2, o.z, 0.001),
  ])));
  g.add(instanced(groundPlane(width, width), MAT.box, slots.map((o) => at(o.x, o.z, 0.002))));

  // Sidewalk slabs + lots in each quadrant; neighbouring slabs form one block.
  const slabs = [];
  const lots = [];
  const lotSize = half - sidewalk;
  for (const o of slots) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        slabs.push(at(o.x + sx * (roadHalf + half / 2), o.z + sz * (roadHalf + half / 2), CURB_H / 2));
        lots.push(at(o.x + sx * (roadHalf + sidewalk + lotSize / 2), o.z + sz * (roadHalf + sidewalk + lotSize / 2), CURB_H + 0.005));
      }
    }
  }
  g.add(instanced(new THREE.BoxGeometry(half, CURB_H, half), MAT.sidewalk, slabs));
  g.add(instanced(groundPlane(lotSize, lotSize), MAT.lot, lots));

  // Markings ------------------------------------------------------------
  const y = 0.012;
  const solid = [];
  const dashes = [];
  const zebra = [];
  const stops = [];

  for (const o of slots) {
    for (const dir of DIRS) {
      const leg = LEG[dir];
      const along = leg.x !== 0;          // leg runs along x
      const from = stopLine;
      const to = roadLength;
      const mid = (from + to) / 2;
      const len = to - from;

      const rect = (alongDist, lateral, l, w) => (along
        ? { x: o.x + leg.x * alongDist, z: o.z + lateral, w: l, d: w }
        : { x: o.x + lateral, z: o.z + leg.z * alongDist, w, d: l });

      // Double centre line, edge lines
      solid.push(rect(mid, -0.18, len, 0.12), rect(mid, 0.18, len, 0.12));
      solid.push(rect(mid, -(roadHalf - 0.3), len, 0.12), rect(mid, roadHalf - 0.3, len, 0.12));

      // Dashed lane dividers (both carriageways)
      for (let d = from + 2; d < to; d += 9) {
        dashes.push(rect(d + 1.5, -laneWidth, 3, 0.12), rect(d + 1.5, laneWidth, 3, 0.12));
      }

      // Stop line across the inbound lanes only
      const a = approach(dir);
      const inboundSign = along ? a.r.z : a.r.x;
      stops.push(rect(stopLine - 0.25, inboundSign * roadHalf / 2, 0.5, roadHalf));

      // Zebra crossing: stripes parallel to traffic
      const cwMid = (crosswalkInner + crosswalkOuter) / 2;
      const cwLen = crosswalkOuter - crosswalkInner;
      for (let lat = -roadHalf + 0.75; lat <= roadHalf - 0.7; lat += 1.25) {
        zebra.push(rect(cwMid, lat, cwLen, 0.62));
      }
    }
  }

  // Roads leaving the network: asphalt, centre line and kerbs out to the fog.
  const outerRoads = [];
  const outerKerbs = [];
  const addOuter = (o, dir) => {
    const leg = LEG[dir];
    const along = leg.x !== 0;
    const mid = roadLength + OUTER_ROAD / 2;
    const x = o.x + leg.x * mid;
    const z = o.z + leg.z * mid;
    const rotY = along ? Math.PI / 2 : 0; // geometry runs along z
    outerRoads.push({ x, y: 0, z, rotY });
    for (const side of [-1, 1]) {
      const lat = side * (roadHalf + sidewalk / 2);
      outerKerbs.push({ x: along ? x : x + lat, y: CURB_H / 2, z: along ? z + lat : z, rotY });
      solid.push(along
        ? { x, z: z + side * (roadHalf - 0.3), w: OUTER_ROAD, d: 0.12 }
        : { x: x + side * (roadHalf - 0.3), z, w: 0.12, d: OUTER_ROAD });
    }
    for (const lat of [-0.18, 0.18]) {
      solid.push(along ? { x, z: z + lat, w: OUTER_ROAD, d: 0.12 } : { x: x + lat, z, w: 0.12, d: OUTER_ROAD });
    }
  };
  for (const o of slots) {
    if (o.row === 0) addOuter(o, 'north');
    if (o.row === layout.rows - 1) addOuter(o, 'south');
    if (o.col === 0) addOuter(o, 'west');
    if (o.col === layout.cols - 1) addOuter(o, 'east');
  }
  g.add(instanced(groundPlane(width, OUTER_ROAD), MAT.road, outerRoads));
  g.add(instanced(new THREE.BoxGeometry(sidewalk, CURB_H, OUTER_ROAD), MAT.sidewalk, outerKerbs));

  g.add(stripes(solid, MAT.markingDim, y));
  g.add(stripes(dashes, MAT.markingDim, y));
  g.add(stripes(stops, MAT.marking, y + 0.001));
  g.add(stripes(zebra, MAT.marking, y + 0.001));

  // Street lighting (pole, arm and head, each one instanced mesh) -------
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 8, 6).translate(0, 4 + CURB_H, 0);
  const armGeo = new THREE.BoxGeometry(2.2, 0.1, 0.1).translate(-1.0, 8 + CURB_H, 0);
  const headGeo = new THREE.BoxGeometry(0.9, 0.12, 0.35).translate(-2.0, 7.9 + CURB_H, 0);
  const lamps = [];
  for (const o of slots) {
    for (const dir of DIRS) {
      const leg = LEG[dir];
      for (const dist of [26, 58, 88]) {
        for (const side of [-1, 1]) {
          const lat = side * (roadHalf + 0.8);
          // Arm points toward the road centreline.
          let rotY;
          if (leg.x !== 0) rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
          else rotY = side > 0 ? 0 : Math.PI;
          lamps.push({
            x: o.x + (leg.x !== 0 ? leg.x * dist : lat),
            z: o.z + (leg.x !== 0 ? lat : leg.z * dist),
            rotY,
          });
        }
      }
    }
  }
  g.add(instanced(poleGeo, MAT.pole, lamps, { receive: false }));
  g.add(instanced(armGeo, MAT.pole, lamps, { receive: false }));
  g.add(instanced(headGeo, MAT.lampHead, lamps, { receive: false }));

  return g;
}

// ------------------------------------------------------- city surroundings

/**
 * Simplified buildings and street trees for every junction of a layout.
 * Each junction's quadrants are seeded by its intersection id (or its grid
 * position for an unmanaged junction), so the surroundings are stable but
 * distinct. Everything is instanced: a few draw calls for the whole city.
 */
export function buildCity(layout) {
  const g = new THREE.Group();
  g.name = 'city-blocks';
  const { roadHalf, sidewalk, roadLength } = LAYOUT;
  const start = roadHalf + sidewalk + 4;
  const end = roadLength - 4;

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.translate(0, 0.5, 0);
  const edgeTemplate = new THREE.EdgesGeometry(unitBox).getAttribute('position').array;

  const buildings = MAT.building.map(() => []);
  const roofs = [];
  const edges = [];
  const trees = [];

  for (const o of layout.slots) {
    const rand = seededRandom(o.id || `junction-${o.col}-${o.row}`);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        let x = start;
        while (x < end - 8) {
          const w = 10 + rand() * 14;
          let z = start;
          while (z < end - 8) {
            const d = 10 + rand() * 14;
            // Keep buildings near the junction low so they never hide the
            // approaches from the default camera; taller ones further out.
            const nearCorner = x < start + 20 && z < start + 20;
            const far = x > 55 || z > 55;
            if (rand() > 0.14 || nearCorner) {
              const h = nearCorner
                ? 5 + rand() * 7
                : far ? 10 + rand() * 22 : 7 + rand() * 12;
              const bw = Math.min(w, end - x) - 1.5;
              const bd = Math.min(d, end - z) - 1.5;
              const bx = o.x + sx * (x + bw / 2);
              const bz = o.z + sz * (z + bd / 2);

              const item = { x: bx, y: CURB_H, z: bz, sx: bw, sy: h, sz: bd };
              buildings[Math.floor(rand() * MAT.building.length)].push(item);
              for (let i = 0; i < edgeTemplate.length; i += 3) {
                edges.push(bx + edgeTemplate[i] * bw, CURB_H + edgeTemplate[i + 1] * h, bz + edgeTemplate[i + 2] * bd);
              }

              // Rooftop plant on taller buildings
              if (h > 20 && rand() > 0.4) {
                roofs.push({
                  x: bx + (rand() - 0.5) * bw * 0.3,
                  y: CURB_H + h,
                  z: bz + (rand() - 0.5) * bd * 0.3,
                  sx: bw * 0.35,
                  sy: 2.2,
                  sz: bd * 0.35,
                });
              }
            }
            z += d + 2 + rand() * 4;
          }
          x += w + 2 + rand() * 4;
        }
      }
    }

    // Street trees along sidewalks
    for (const dir of DIRS) {
      const leg = LEG[dir];
      for (let dist = 20; dist < roadLength - 6; dist += 11 + rand() * 6) {
        for (const side of [-1, 1]) {
          if (rand() < 0.3) continue;
          const lat = side * (roadHalf + sidewalk - 1.2);
          const k = 0.8 + rand() * 0.45;
          trees.push({
            x: o.x + (leg.x !== 0 ? leg.x * dist : lat),
            z: o.z + (leg.x !== 0 ? lat : leg.z * dist),
            k,
            rotY: rand() * Math.PI,
          });
        }
      }
    }
  }

  buildings.forEach((items, i) => {
    if (items.length) g.add(instanced(unitBox, MAT.building[i], items, { cast: true }));
  });
  if (roofs.length) g.add(instanced(unitBox, MAT.roof, roofs, { cast: true, receive: false }));
  const edgeGeo = new THREE.BufferGeometry();
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  g.add(new THREE.LineSegments(edgeGeo, MAT.edges));

  const crownGeo = new THREE.IcosahedronGeometry(1.8, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.18, 2.2, 5);
  g.add(instanced(crownGeo, MAT.tree, trees.map((t) => ({
    x: t.x, y: CURB_H + 3.4 * t.k, z: t.z, rotY: t.rotY, sx: t.k, sy: t.k * 1.15, sz: t.k,
  })), { cast: true, receive: false }));
  g.add(instanced(trunkGeo, MAT.trunk, trees.map((t) => ({ x: t.x, y: CURB_H + 1.1, z: t.z, rotY: t.rotY })), { receive: false }));

  return g;
}
