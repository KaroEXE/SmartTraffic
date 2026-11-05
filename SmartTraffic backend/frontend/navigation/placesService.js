import { NAV_CONFIG } from './config.js';
import { isValidLatLng } from './geo.js';
import { fetchOsmLayer } from './hazardService.js';

/**
 * Important places highlighted on the map (no DOM), from OpenStreetMap.
 * Same provider shape as hazardService.js, so createHazardLoader() loads them.
 *
 * Place: { id, kind: 'health' | 'places', category, label, name, altName, lat, lng, url }
 *   kind is the map layer: 'health' = hospitals and clinics, 'places' = the rest.
 */

// category -> [OSM key, OSM value, layer, label]
export const PLACE_CATEGORIES = {
  hospital: ['amenity', 'hospital', 'health', 'Hospital'],
  clinic: ['amenity', 'clinic', 'health', 'Clinic'],
  police: ['amenity', 'police', 'places', 'Police'],
  fire_station: ['amenity', 'fire_station', 'places', 'Fire station'],
  fuel: ['amenity', 'fuel', 'places', 'Fuel station'],
  university: ['amenity', 'university', 'places', 'University'],
  bus_station: ['amenity', 'bus_station', 'places', 'Bus station'],
  townhall: ['amenity', 'townhall', 'places', 'Government office'],
  airport: ['aeroway', 'aerodrome', 'places', 'Airport'],
  mall: ['shop', 'mall', 'places', 'Shopping mall'],
};

export const PLACE_LAYERS = ['health', 'places'];

export function buildPlacesQuery(bbox, maxResults = NAV_CONFIG.places.maxResults) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const byKey = {};
  for (const [key, value] of Object.values(PLACE_CATEGORIES)) (byKey[key] = byKey[key] || []).push(value);
  const parts = Object.entries(byKey).map(([key, values]) => `nwr["${key}"~"^(${values.join('|')})$"](${b});`);
  // Hospitals first, so they survive the result limit in dense areas.
  return `[out:json][timeout:20];nwr["amenity"="hospital"](${b})->.h;(${parts.join('')})->.all;(.all; - .h;)->.rest;.h out center tags;.rest out center tags ${maxResults};`;
}

function categoryOf(tags) {
  for (const [category, [key, value]] of Object.entries(PLACE_CATEGORIES)) if (tags[key] === value) return category;
  return null;
}

/** Overpass JSON -> Place[]. Elements without a position or a known category are skipped. */
export function parsePlaces(json, lang = 'en') {
  const out = [];
  const seen = new Set();
  for (const el of (json && json.elements) || []) {
    const tags = el.tags || {};
    const lat = Number.isFinite(el.lat) ? el.lat : el.center && el.center.lat;
    const lng = Number.isFinite(el.lon) ? el.lon : el.center && el.center.lon;
    const category = categoryOf(tags);
    const id = `osm-${el.type}-${el.id}`;
    if (!category || !isValidLatLng({ lat, lng }) || seen.has(id)) continue;
    seen.add(id);
    const [, , kind, label] = PLACE_CATEGORIES[category];
    const local = tags[`name:${lang}`];
    const name = local || tags.name || tags['name:en'] || null;
    const altName = tags.name && tags.name !== name ? tags.name : null;
    out.push({ id, kind, category, label, name, altName, lat, lng, url: `https://www.openstreetmap.org/${el.type}/${el.id}` });
  }
  return out;
}

export function createPlacesProvider(cfg = NAV_CONFIG.places) {
  const lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language.split('-')[0] : 'en';
  return {
    name: 'OpenStreetMap',
    kinds: [...PLACE_LAYERS],
    async fetchHazards(bbox, { signal } = {}) {
      return parsePlaces(await fetchOsmLayer(cfg.osmUrl, bbox, { signal, timeoutMs: cfg.timeoutMs }), lang);
    },
  };
}
