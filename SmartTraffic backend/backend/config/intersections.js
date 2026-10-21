/**
 * Intersections managed by this backend (the live channel).
 *
 * The intersections of the operator's road network, as listed in the
 * Python integration contract (docs/python-integration-contract.md). `id`
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
 * Position: `positionSource` says how reliable lat/lng are.
 *   surveyed     set from the environment (INTERSECTION_LAT / INTERSECTION_LNG
 *                for "main") - the real junction
 *   placeholder  an approximate position in the city, not surveyed. The
 *                dashboard labels these, and driver navigation (which adds
 *                live traffic only within 60 m of a junction) should not be
 *                trusted for them until they are surveyed.
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

const mainLat = coordinate('INTERSECTION_LAT', 35.5617, 90);
const mainLng = coordinate('INTERSECTION_LNG', 45.4329, 180);

module.exports = [
  {
    id: 'main',
    name: (process.env.INTERSECTION_NAME || '').trim().slice(0, 80) || 'Main Street',
    lat: mainLat.value,
    lng: mainLng.value,
    positionSource: mainLat.fromEnv && mainLng.fromEnv ? 'surveyed' : 'placeholder',
    grid: { col: 0, row: 1 },
  },
  {
    id: 'university-road', name: 'University Road', lat: 35.5702, lng: 45.4418, positionSource: 'placeholder', grid: { col: 2, row: 0 },
  },
  {
    id: 'market-square', name: 'Market Square', lat: 35.5560, lng: 45.4385, positionSource: 'placeholder', grid: { col: 1, row: 1 },
  },
  {
    id: 'hospital-junction', name: 'Hospital Junction', lat: 35.5655, lng: 45.4232, positionSource: 'placeholder', grid: { col: 0, row: 0 },
  },
  {
    id: 'ring-road-north', name: 'Ring Road North', lat: 35.5768, lng: 45.4305, positionSource: 'placeholder', grid: { col: 1, row: 0 },
  },
];
