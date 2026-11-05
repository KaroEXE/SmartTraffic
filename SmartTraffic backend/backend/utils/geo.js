/**
 * Geometry for the navigation API (no I/O).
 *
 * Points are { lat, lng }. Lines are GeoJSON positions, [[lng, lat], ...],
 * the order the API returns and MongoDB stores. Distances are metres.
 *
 * Ported from the web navigation page (frontend/navigation/geo.js and
 * routeRanking.js), which works in Leaflet's [lat, lng] order; the
 * algorithms and thresholds are the same.
 */

const EARTH_RADIUS_M = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;
const toPoint = ([lng, lat]) => ({ lat, lng });

function isValidLatLng(point) {
  return Boolean(point)
    && typeof point.lat === 'number' && typeof point.lng === 'number'
    && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90
    && point.lng >= -180 && point.lng <= 180;
}

/** Great-circle distance in metres. */
function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Closest approach of a point to a line: { distanceMeters, alongMeters },
 * where alongMeters is the distance from the start of the line to the
 * closest position on it. Uses a flat projection around the point, accurate
 * for the short distances involved in matching things to a route.
 */
function locateOnLine(point, line) {
  if (!line || line.length === 0) return { distanceMeters: Infinity, alongMeters: 0 };
  const kx = EARTH_RADIUS_M * rad(1) * Math.cos(rad(point.lat));
  const ky = EARTH_RADIUS_M * rad(1);
  const project = ([lng, lat]) => [(lng - point.lng) * kx, (lat - point.lat) * ky];

  let [ax, ay] = project(line[0]);
  if (line.length === 1) return { distanceMeters: Math.hypot(ax, ay), alongMeters: 0 };
  let best = Infinity;
  let bestAlong = 0;
  let along = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [bx, by] = project(line[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Projection of the origin (the point) onto segment a-b, clamped to it.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    const segment = Math.sqrt(len2);
    if (d < best) {
      best = d;
      bestAlong = along + t * segment;
    }
    along += segment;
    ax = bx;
    ay = by;
  }
  return { distanceMeters: best, alongMeters: bestAlong };
}

function distanceToLineMeters(point, line) {
  return locateOnLine(point, line).distanceMeters;
}

/** Compass bearing in degrees (0 = north, clockwise) from a to b. */
function bearingDegrees(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat))
    - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) / rad(1)) + 360) % 360;
}

/** Points along a line about every `step` metres (always includes the ends). */
function samplePolyline(line, step = 25) {
  if (!line || line.length === 0) return [];
  const out = [{ ...toPoint(line[0]), along: 0 }];
  let along = 0;
  let next = step;
  for (let i = 1; i < line.length; i += 1) {
    const a = toPoint(line[i - 1]);
    const b = toPoint(line[i]);
    const seg = distanceMeters(a, b);
    while (seg > 0 && next <= along + seg) {
      const t = (next - along) / seg;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, along: next });
      next += step;
    }
    along += seg;
  }
  const last = toPoint(line[line.length - 1]);
  if (along - out[out.length - 1].along > 1) out.push({ ...last, along });
  return out;
}

/** Share (0-1) of line `a`'s length that runs within `toleranceM` of line `b`. */
function overlapRatio(a, b, toleranceM = 30) {
  const samples = samplePolyline(a, 25);
  if (!samples.length) return 0;
  const near = samples.filter((p) => distanceToLineMeters(p, b) <= toleranceM).length;
  return near / samples.length;
}

/**
 * True when the line doubles back on itself: it returns within `nearM` of a
 * point it passed at least `gapM` earlier (an out-and-back spur to a via
 * point). Such a route is not a real alternative.
 */
function hasBacktrack(line, { nearM = 15, gapM = 200 } = {}) {
  const s = samplePolyline(line, 20);
  for (let i = 0; i < s.length; i += 1) {
    for (let j = i + 1; j < s.length; j += 1) {
      if (s[j].along - s[i].along < gapM) continue;
      if (distanceMeters(s[i], s[j]) <= nearM) return true;
    }
  }
  return false;
}

/**
 * Via points for extra route alternatives: beside the straight
 * start-destination line, nearest first. The router turns each into a
 * road-following route.
 */
function viaCandidates(start, destination) {
  const d = distanceMeters(start, destination);
  const kx = 111320 * Math.cos(rad(start.lat));
  const ky = 110540;
  const dx = (destination.lng - start.lng) * kx;
  const dy = (destination.lat - start.lat) * ky;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; // unit normal (metres)
  const ny = dx / len;
  const at = (t, offset) => ({
    lat: start.lat + (dy * t + ny * offset * d) / ky,
    lng: start.lng + (dx * t + nx * offset * d) / kx,
  });
  return [
    at(0.5, 0.2), at(0.5, -0.2),
    at(0.5, 0.35), at(0.5, -0.35),
    at(0.35, 0.3), at(0.65, -0.3),
    at(0.65, 0.3), at(0.35, -0.3),
    at(0.5, 0.5), at(0.5, -0.5),
    at(0.25, 0.15), at(0.75, -0.15),
  ];
}

/**
 * A candidate is a usable extra route when it follows different roads from
 * every route already found, does not double back, and is not an absurd
 * detour compared with the fastest route. Routes: { geometry, duration }.
 */
function isUsefulAlternative(candidate, existing, { maxOverlap = 0.8, maxDetourFactor = 2.5 } = {}) {
  const line = candidate.geometry.coordinates;
  if (hasBacktrack(line)) return false;
  const fastest = Math.min(...existing.map((r) => r.duration));
  if (Number.isFinite(fastest) && candidate.duration > fastest * maxDetourFactor) return false;
  return existing.every((r) => overlapRatio(line, r.geometry.coordinates) < maxOverlap
    && overlapRatio(r.geometry.coordinates, line) < maxOverlap);
}

// --------------------------------------------------------------- bounding boxes

/** Bounding box { south, west, north, east } of several lines, or null. */
function bboxOfLines(lines) {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const line of lines) {
    for (const [lng, lat] of line) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lng);
      east = Math.max(east, lng);
    }
  }
  return Number.isFinite(south) ? { south, west, north, east } : null;
}

/** Grows a bbox by `meters` on every side (clamped to valid coordinates). */
function padBBoxMeters(bbox, meters) {
  const dLat = meters / 110540;
  const midLat = (bbox.north + bbox.south) / 2;
  const dLng = meters / (111320 * Math.max(0.01, Math.cos(rad(midLat))));
  return {
    south: Math.max(-90, bbox.south - dLat),
    north: Math.min(90, bbox.north + dLat),
    west: Math.max(-180, bbox.west - dLng),
    east: Math.min(180, bbox.east + dLng),
  };
}

function bboxContainsPoint(bbox, point) {
  return point.lat >= bbox.south && point.lat <= bbox.north && point.lng >= bbox.west && point.lng <= bbox.east;
}

/** GeoJSON Polygon of a bbox. */
function bboxPolygon({ south, west, north, east }) {
  return {
    type: 'Polygon',
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

/**
 * Polygon for a MongoDB $geoWithin query that covers the whole bbox.
 * MongoDB treats polygon edges as great-circle arcs, which bow towards the
 * pole away from the box's lines of latitude (about 28 m for a 0.5 degree
 * wide box, kilometres for a long route's box), so the box is padded by that
 * amount. Callers keep only the results inside the exact box
 * (bboxContainsPoint).
 */
function bboxQueryPolygon(bbox) {
  const dLng = rad(bbox.east - bbox.west);
  // R * dLng^2 / 8 * sin(lat) * cos(lat), with sin*cos at its maximum of 1/2.
  const slack = (EARTH_RADIUS_M * dLng * dLng) / 16 + 1;
  return bboxPolygon(padBBoxMeters(bbox, slack));
}

module.exports = {
  isValidLatLng,
  distanceMeters,
  locateOnLine,
  distanceToLineMeters,
  bearingDegrees,
  samplePolyline,
  overlapRatio,
  hasBacktrack,
  viaCandidates,
  isUsefulAlternative,
  bboxOfLines,
  padBBoxMeters,
  bboxContainsPoint,
  bboxPolygon,
  bboxQueryPolygon,
};
