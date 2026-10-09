/**
 * Geometry helpers (no DOM). Points are { lat, lng }; polylines are arrays
 * of [lat, lng] pairs, the form Leaflet uses.
 */

const EARTH_RADIUS_M = 6371008.8;
const rad = (deg) => (deg * Math.PI) / 180;

export function isValidLatLng(point) {
  return Boolean(point)
    && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90
    && point.lng >= -180 && point.lng <= 180;
}

/** Great-circle distance in metres. */
export function distanceMeters(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest distance in metres from a point to a polyline. Uses a local flat
 * projection around the point, accurate for the short distances involved in
 * matching an intersection to a route.
 */
export function distanceToPolylineMeters(point, polyline) {
  if (!polyline || polyline.length === 0) return Infinity;
  const kx = EARTH_RADIUS_M * rad(1) * Math.cos(rad(point.lat));
  const ky = EARTH_RADIUS_M * rad(1);
  const project = ([lat, lng]) => [(lng - point.lng) * kx, (lat - point.lat) * ky];

  if (polyline.length === 1) {
    const [x, y] = project(polyline[0]);
    return Math.hypot(x, y);
  }
  let best = Infinity;
  let [ax, ay] = project(polyline[0]);
  for (let i = 1; i < polyline.length; i += 1) {
    const [bx, by] = project(polyline[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // Projection of the origin (the point) onto segment a-b, clamped to it.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    ax = bx;
    ay = by;
  }
  return best;
}

/** Bounding box { south, west, north, east } of [lat, lng] pairs, or null. */
export function boundsOf(points) {
  if (!points || points.length === 0) return null;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const [lat, lng] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lng);
    east = Math.max(east, lng);
  }
  return { south, west, north, east };
}

/** True when bbox `inner` lies completely inside bbox `outer`. */
export function bboxContains(outer, inner) {
  return Boolean(outer && inner)
    && inner.south >= outer.south && inner.north <= outer.north
    && inner.west >= outer.west && inner.east <= outer.east;
}

/** Grows a bbox by a fraction of its size on every side. */
export function padBBox(bbox, fraction) {
  const dLat = (bbox.north - bbox.south) * fraction;
  const dLng = (bbox.east - bbox.west) * fraction;
  return {
    south: Math.max(-90, bbox.south - dLat),
    north: Math.min(90, bbox.north + dLat),
    west: Math.max(-180, bbox.west - dLng),
    east: Math.min(180, bbox.east + dLng),
  };
}
