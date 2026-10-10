/**
 * Intersections managed by this backend (the live channel).
 *
 * One intersection: the one the AI service's four videos watch (north, south,
 * west and east approach). `id` is the value the AI service sends as
 * `intersectionId` in POST /api/traffic (its INTERSECTION_ID, default "main").
 * Add an entry here only together with an AI service that reports it: an
 * intersection without a feed would show signals but no traffic data.
 *
 * Position: set INTERSECTION_LAT and INTERSECTION_LNG (and optionally
 * INTERSECTION_NAME) to the surveyed position of the real junction. The
 * driver navigation adds live traffic only to routes that pass within 60 m
 * of this point, so it must be on the roads the junction joins. The default
 * below is a placeholder.
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function coordinate(name, fallback, limit) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && Math.abs(value) <= limit) return value;
  console.warn(`[config] ${name}="${raw}" is not a valid coordinate - using ${fallback}`);
  return fallback;
}

module.exports = [
  {
    id: 'main',
    name: (process.env.INTERSECTION_NAME || '').trim().slice(0, 80) || 'Main Street',
    lat: coordinate('INTERSECTION_LAT', 35.5617, 90),
    lng: coordinate('INTERSECTION_LNG', 45.4329, 180),
  },
];
