/**
 * Intersections managed by this backend (the live channel).
 *
 * The intersections of the operator's road network, as listed in the
 * Python integration contract (python/docs/RENDER_DEPLOYMENT.md). `id`
 * is the value the AI service sends as `intersectionId` in POST /api/traffic
 * and that camera streams are registered to (POST /api/streams).
 *
 * An intersection only gets traffic data from an AI feed that reports it.
 * Until one does, the dashboard shows it as "waiting for live data" (no
 * counts, never zeros) and its controller runs the fixed-time plan. Nothing
 * here is a measurement.
 *
 * Network: `grid` places the intersection on the street grid used by the
 * network coordinator, the emergency corridor and the 3D scene (row 0 =
 * north, col 0 = west; neighbouring cells are joined by a road). See
 * services/networkTopology.js. The grid is a configured schematic.
 *
 * Position: `positionSource` says where lat/lng come from.
 *   surveyed     the real junction: INTERSECTION_LAT / INTERSECTION_LNG for
 *                "main", or lat/lng written here for another intersection once
 *                it has been surveyed (then set positionSource to 'surveyed')
 *   unknown      lat and lng are null. Nothing is invented: the intersection is
 *                not drawn on any map and never matched to a route, but its
 *                signal control, AI data and the simulation work as usual.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function coordinate(name, fallback, limit) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return { value: fallback, fromEnv: false };
  const value = Number(raw);
  if (Number.isFinite(value) && Math.abs(value) <= limit) return { value, fromEnv: true };
  console.warn(`[config] ${name}="${raw}" is not a valid coordinate - using ${fallback}`);
  return { value: fallback, fromEnv: false };
}

const mainLat = coordinate('INTERSECTION_LAT', null, 90);
const mainLng = coordinate('INTERSECTION_LNG', null, 180);
const UNKNOWN = { lat: null, lng: null, positionSource: 'unknown' };

module.exports = [
  {
    id: 'main',
    name: (process.env.INTERSECTION_NAME || '').trim().slice(0, 80) || 'Main Street',
    lat: mainLat.value,
    lng: mainLng.value,
    positionSource: mainLat.fromEnv && mainLng.fromEnv ? 'surveyed' : 'unknown',
    grid: { col: 0, row: 1 },
  },
  {
    id: 'university-road', name: 'University Road', ...UNKNOWN, grid: { col: 2, row: 0 },
  },
  {
    id: 'market-square', name: 'Market Square', ...UNKNOWN, grid: { col: 1, row: 1 },
  },
  {
    id: 'hospital-junction', name: 'Hospital Junction', ...UNKNOWN, grid: { col: 0, row: 0 },
  },
  {
    id: 'ring-road-north', name: 'Ring Road North', ...UNKNOWN, grid: { col: 1, row: 0 },
  },
];
