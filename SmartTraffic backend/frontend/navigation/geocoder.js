import { NAV_CONFIG } from './config.js';
import { isValidLatLng } from './geo.js';

/**
 * Destination search via Nominatim (OpenStreetMap).
 *
 * Nominatim's usage policy allows at most one request per second and no
 * search-as-you-type, so searches run on submit only and are spaced at least
 * `minIntervalMs` apart.
 *
 * Place: { id, name, address, lat, lng }
 */

export class GeocodeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // too-short | offline | network | timeout | provider | aborted
  }
}

/** Nominatim jsonv2 results -> Place[]. */
export function parseNominatim(json) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const r of json) {
    const lat = Number.parseFloat(r.lat);
    const lng = Number.parseFloat(r.lon);
    if (!isValidLatLng({ lat, lng })) continue;
    const display = typeof r.display_name === 'string' ? r.display_name : '';
    const name = (typeof r.name === 'string' && r.name) || display.split(',')[0] || 'Unnamed place';
    out.push({ id: `${r.osm_type || 'x'}-${r.osm_id || out.length}`, name, address: display, lat, lng });
  }
  return out;
}

/**
 * Search area around the map view, at least `minSpanDeg` wide so a zoomed-in
 * map still searches the surrounding city.
 */
export function localSearchBox(viewbox, minSpanDeg) {
  const lat = (viewbox.north + viewbox.south) / 2;
  const lng = (viewbox.east + viewbox.west) / 2;
  const halfLat = Math.max(viewbox.north - viewbox.south, minSpanDeg) / 2;
  const halfLng = Math.max(viewbox.east - viewbox.west, minSpanDeg) / 2;
  return {
    south: Math.max(-90, lat - halfLat),
    north: Math.min(90, lat + halfLat),
    west: Math.max(-180, lng - halfLng),
    east: Math.min(180, lng + halfLng),
  };
}

export function createGeocoder(cfg = NAV_CONFIG.geocoding) {
  let lastRequestAt = 0;
  let controller = null;

  async function request(q, box, bounded, signal) {
    const wait = lastRequestAt + cfg.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal.aborted) throw new GeocodeError('aborted', 'Search cancelled.');
    lastRequestAt = Date.now();

    const params = new URLSearchParams({ format: 'jsonv2', q, limit: String(cfg.resultLimit), addressdetails: '0' });
    if (box) params.set('viewbox', `${box.west},${box.north},${box.east},${box.south}`);
    if (box && bounded) params.set('bounded', '1');
    if (typeof navigator !== 'undefined' && navigator.language) params.set('accept-language', navigator.language);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutMs);
    try {
      const res = await fetch(`${cfg.nominatimUrl.replace(/\/$/, '')}/search?${params}`, { signal });
      if (!res.ok) throw new GeocodeError('provider', `Search service answered HTTP ${res.status}.`);
      return parseNominatim(await res.json());
    } catch (err) {
      if (err instanceof GeocodeError) throw err;
      if (timedOut) throw new GeocodeError('timeout', 'The search service did not answer in time.');
      if (signal.aborted) throw new GeocodeError('aborted', 'Search cancelled.');
      throw new GeocodeError('network', 'The search service could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Searches near the map first (`viewbox` = { south, west, north, east }),
     * then everywhere if nothing is found nearby.
     * Resolves { places, scope: 'local' | 'global' }.
     */
    async search(query, { viewbox } = {}) {
      const q = String(query || '').trim();
      if (q.length < cfg.minQueryLength) {
        throw new GeocodeError('too-short', `Type at least ${cfg.minQueryLength} characters.`);
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new GeocodeError('offline', 'You are offline. Search needs an internet connection.');
      }
      if (controller) controller.abort();
      controller = new AbortController();
      const { signal } = controller;

      if (viewbox) {
        const local = await request(q, localSearchBox(viewbox, cfg.localSpanDeg), true, signal);
        if (local.length) return { places: local, scope: 'local' };
      }
      return { places: await request(q, viewbox, false, signal), scope: 'global' };
    },

    cancel() {
      if (controller) controller.abort();
    },
  };
}
