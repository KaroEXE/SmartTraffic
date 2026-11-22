/**
 * Map configuration and geometry helpers shared by every web map. No DOM, no map
 * library: it runs in the browser and in Node tests.
 *
 * The map itself is OpenFreeMap (vector tiles, no key, no request limit) drawn by
 * MapLibre GL JS (mapCore.js). The style URL, the area the map is fixed to and the zoom
 * range come from the backend (GET /api/client-config), so the web and the mobile app
 * read the same values.
 */

/** { map: { styleUrl, bounds: { south, west, north, east }, minZoom, maxZoom, attribution }, searchAttribution } or null. */
export async function loadMapConfig(url = '/api/client-config') {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const m = json && json.map;
    if (!m || typeof m.styleUrl !== 'string' || !m.bounds) return null;
    const b = m.bounds;
    if (![b.south, b.west, b.north, b.east].every(Number.isFinite)) return null;
    return { map: m, searchAttribution: json.searchAttribution || null };
  } catch {
    return null;
  }
}

/** { south, west, north, east } -> MapLibre's [[west, south], [east, north]]. */
export const toMapBounds = (b) => [[b.west, b.south], [b.east, b.north]];

/** Centre of the area as { lat, lng }. */
export const boundsCenter = (b) => ({ lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 });

/** [lat, lng] pairs (the format of routes and ranking code) -> MapLibre's [lng, lat] pairs. */
export const latLngsToLngLats = (pairs) => pairs.map(([lat, lng]) => [lng, lat]);

/** A GeoJSON FeatureCollection from features. */
export const featureCollection = (features) => ({ type: 'FeatureCollection', features });

/** A GeoJSON polygon approximating a circle of `radiusMeters` around a point (the accuracy of a GPS fix). */
export function circlePolygon({ lat, lng }, radiusMeters, steps = 48) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ring = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lng + (Math.cos(a) * radiusMeters) / kx, lat + (Math.sin(a) * radiusMeters) / 110540]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** Whether a point lies inside the area. */
export const insideBounds = (b, { lat, lng }) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

/**
 * The marker icons drawn on the map (mapCore.addHawrIcons): one colour and glyph each.
 * Road features, driver reports and Hawr places share the one symbol layer mechanism.
 */
export const MAP_ICONS = {
  speed_camera: { color: '#e5484d', glyph: 'camera' },
  speed_bump: { color: '#f2b632', glyph: 'bump' },
  road_closure: { color: '#e5484d', glyph: '!' },
  roadworks: { color: '#f08c2e', glyph: '!' },
  accident: { color: '#e5484d', glyph: '!' },
  traffic_jam: { color: '#f08c2e', glyph: '!' },
  construction: { color: '#f08c2e', glyph: '!' },
  hazard: { color: '#f2b632', glyph: '!' },
  place: { color: '#3b82f6', glyph: 'dot' },
};
