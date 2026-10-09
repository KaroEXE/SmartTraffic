import * as THREE from 'three';

/**
 * Static geometry for a four-way intersection plus the shared layout and
 * path helpers used by vehicles, pedestrians and signals.
 *
 * World axes: +x = east, -z = north, +y = up. Units are metres.
 * Right-hand traffic, two inbound + two outbound lanes per leg.
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

function flatPlane(w, d, material, x, y, z, rotY = 0) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.rotation.z = rotY;
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  return mesh;
}

/** Many thin flat rectangles as one InstancedMesh (lane dashes, zebra stripes). */
function stripes(rects, material, y) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, material, rects.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  rects.forEach((r, i) => {
    p.set(r.x, y, r.z);
    s.set(r.w, 1, r.d);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
  });
  mesh.receiveShadow = true;
  return mesh;
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

// --------------------------------------------------------- static scene

export function buildStaticIntersection() {
  const g = new THREE.Group();
  g.name = 'intersection-static';
  const { roadHalf, roadLength, sidewalk, crosswalkInner, crosswalkOuter, stopLine, laneWidth } = LAYOUT;
  const width = roadHalf * 2;

  // Ground
  const ground = flatPlane(900, 900, MAT.ground, 0, -0.02, 0);
  g.add(ground);

  // Roads: N-S strip full length, E-W legs either side, centre box
  g.add(flatPlane(width, roadLength * 2, MAT.road, 0, 0, 0));
  g.add(flatPlane(roadLength - roadHalf, width, MAT.road, (roadLength + roadHalf) / 2, 0.001, 0));
  g.add(flatPlane(roadLength - roadHalf, width, MAT.road, -(roadLength + roadHalf) / 2, 0.001, 0));
  g.add(flatPlane(width, width, MAT.box, 0, 0.002, 0));

  // Sidewalk slabs + lots in each quadrant
  const curbH = 0.15;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const size = roadLength - roadHalf;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(size, curbH, size), MAT.sidewalk);
      slab.position.set(sx * (roadHalf + size / 2), curbH / 2, sz * (roadHalf + size / 2));
      slab.receiveShadow = true;
      g.add(slab);

      const lotSize = size - sidewalk;
      g.add(flatPlane(lotSize, lotSize, MAT.lot,
        sx * (roadHalf + sidewalk + lotSize / 2), curbH + 0.005, sz * (roadHalf + sidewalk + lotSize / 2)));
    }
  }

  // Markings ------------------------------------------------------------
  const y = 0.012;
  const solid = [];
  const dashes = [];
  const zebra = [];
  const stops = [];

  for (const dir of DIRS) {
    const leg = LEG[dir];
    const along = leg.x !== 0;          // leg runs along x
    const from = stopLine;
    const to = roadLength;
    const mid = (from + to) / 2;
    const len = to - from;

    const rect = (alongDist, lateral, l, w) => (along
      ? { x: leg.x * alongDist, z: lateral, w: l, d: w }
      : { x: lateral, z: leg.z * alongDist, w, d: l });

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

  g.add(stripes(solid, MAT.markingDim, y));
  g.add(stripes(dashes, MAT.markingDim, y));
  g.add(stripes(stops, MAT.marking, y + 0.001));
  g.add(stripes(zebra, MAT.marking, y + 0.001));

  // Street lighting -----------------------------------------------------
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 8, 6);
  const armGeo = new THREE.BoxGeometry(2.2, 0.1, 0.1);
  const headGeo = new THREE.BoxGeometry(0.9, 0.12, 0.35);
  for (const dir of DIRS) {
    const leg = LEG[dir];
    for (const dist of [26, 58, 88]) {
      for (const side of [-1, 1]) {
        const lat = side * (roadHalf + 0.8);
        const px = leg.x !== 0 ? leg.x * dist : lat;
        const pz = leg.x !== 0 ? lat : leg.z * dist;
        const lamp = new THREE.Group();
        const pole = new THREE.Mesh(poleGeo, MAT.pole);
        pole.position.y = 4 + curbH;
        const arm = new THREE.Mesh(armGeo, MAT.pole);
        arm.position.set(-1.0, 8 + curbH, 0);
        const head = new THREE.Mesh(headGeo, MAT.lampHead);
        head.position.set(-2.0, 7.9 + curbH, 0);
        lamp.add(pole, arm, head);
        lamp.position.set(px, 0, pz);
        // Arm points toward the road centreline.
        if (leg.x !== 0) lamp.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
        else lamp.rotation.y = side > 0 ? 0 : Math.PI;
        g.add(lamp);
      }
    }
  }

  return g;
}

// ------------------------------------------------------- city surroundings

/**
 * Simplified buildings and trees. Seeded by intersection id so every
 * intersection gets a stable but distinct surrounding.
 */
export function buildCityBlocks(seedText) {
  const rand = seededRandom(seedText || 'default');
  const g = new THREE.Group();
  g.name = 'city-blocks';
  const { roadHalf, sidewalk, roadLength } = LAYOUT;
  const curbH = 0.15;
  const start = roadHalf + sidewalk + 4;
  const end = roadLength - 4;

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.translate(0, 0.5, 0);
  const unitEdges = new THREE.EdgesGeometry(unitBox);

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
            const cx = sx * (x + bw / 2);
            const cz = sz * (z + bd / 2);

            const mat = MAT.building[Math.floor(rand() * MAT.building.length)];
            const mesh = new THREE.Mesh(unitBox, mat);
            mesh.scale.set(bw, h, bd);
            mesh.position.set(cx, curbH, cz);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            g.add(mesh);

            const edges = new THREE.LineSegments(unitEdges, MAT.edges);
            edges.scale.copy(mesh.scale);
            edges.position.copy(mesh.position);
            g.add(edges);

            // Rooftop plant on taller buildings
            if (h > 20 && rand() > 0.4) {
              const roof = new THREE.Mesh(unitBox, MAT.roof);
              roof.scale.set(bw * 0.35, 2.2, bd * 0.35);
              roof.position.set(cx + (rand() - 0.5) * bw * 0.3, curbH + h, cz + (rand() - 0.5) * bd * 0.3);
              roof.castShadow = true;
              g.add(roof);
            }
          }
          z += d + 2 + rand() * 4;
        }
        x += w + 2 + rand() * 4;
      }
    }
  }

  // Street trees along sidewalks (instanced)
  const positions = [];
  for (const dir of DIRS) {
    const leg = LEG[dir];
    for (let dist = 20; dist < roadLength - 6; dist += 11 + rand() * 6) {
      for (const side of [-1, 1]) {
        if (rand() < 0.3) continue;
        const lat = side * (roadHalf + sidewalk - 1.2);
        positions.push(leg.x !== 0 ? [leg.x * dist, lat] : [lat, leg.z * dist]);
      }
    }
  }
  const crownGeo = new THREE.IcosahedronGeometry(1.8, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.18, 2.2, 5);
  const crowns = new THREE.InstancedMesh(crownGeo, MAT.tree, positions.length);
  const trunks = new THREE.InstancedMesh(trunkGeo, MAT.trunk, positions.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  positions.forEach(([px, pz], i) => {
    const k = 0.8 + rand() * 0.45;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
    p.set(px, curbH + 3.4 * k, pz);
    s.set(k, k * 1.15, k);
    m.compose(p, q, s);
    crowns.setMatrixAt(i, m);
    p.set(px, curbH + 1.1, pz);
    s.set(1, 1, 1);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
  });
  crowns.castShadow = true;
  g.add(crowns, trunks);

  return g;
}
