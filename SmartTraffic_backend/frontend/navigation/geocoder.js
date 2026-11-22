import { NAV_CONFIG } from './config.js';
import { isValidLatLng } from './geo.js';

/**
 * Destination search through the SmartTraffic backend (GET /api/search), which answers from
 * its own PostgreSQL/PostGIS database (OpenStreetMap data): no search provider is called from
 * here or from the backend. Searches run on submit, not on every key, and the backend limits
 * requests per client.
 *
 * Place: { id, name, address, lat, lng }
 */

export class GeocodeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // too-short | offline | network | timeout | provider | busy | aborted
  }
}

/** Backend answer { results: [...] } -> Place[]. Entries without a usable position or name are skipped. */
export function parsePlaces(json) {
  if (!json || !Array.isArray(json.results)) return [];
  const out = [];
  for (const p of json.results) {
    if (!p || typeof p.latitude !== 'number' || typeof p.longitude !== 'number' || !isValidLatLng({ lat: p.latitude, lng: p.longitude })) continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null;
    if (!name) continue;
    out.push({
      id: typeof p.id === 'string' ? p.id : `place-${out.length}`,
      name,
      address: typeof p.address === 'string' ? p.address : '',
      lat: p.latitude,
      lng: p.longitude,
    });
  }
  return out;
}

const BUSY_CODES = new Set(['RATE_LIMITED', 'GEO_DATABASE_UNAVAILABLE', 'GEO_QUERY_TIMEOUT']);
const NOT_SET_UP_CODES = new Set(['FEATURE_DISABLED', 'GEO_DATA_NOT_READY']);

export function createGeocoder(cfg = NAV_CONFIG.geocoding) {
  let controller = null;

  return {
    /**
     * Searches by name, ranked towards the map view's centre (`viewbox` =
     * { south, west, north, east }) when given.
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

      const params = new URLSearchParams({ q, limit: String(cfg.resultLimit) });
      if (viewbox) {
        params.set('lat', String((viewbox.north + viewbox.south) / 2));
        params.set('lng', String((viewbox.east + viewbox.west) / 2));
      }
      if (typeof navigator !== 'undefined' && navigator.language) params.set('lang', navigator.language.split('-')[0]);

      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, cfg.timeoutMs);
      try {
        const res = await fetch(`${cfg.url}?${params}`, { signal });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          if (json && BUSY_CODES.has(json.code)) throw new GeocodeError('busy', 'The search service is busy. Try again in a moment.');
          if (json && NOT_SET_UP_CODES.has(json.code)) throw new GeocodeError('provider', 'Search is not set up on this server.');
          throw new GeocodeError('provider', `The search service answered HTTP ${res.status}.`);
        }
        // 'local': ranked towards the map view; 'global': no position was sent.
        return { places: parsePlaces(json), scope: viewbox ? 'local' : 'global' };
      } catch (err) {
        if (err instanceof GeocodeError) throw err;
        if (timedOut) throw new GeocodeError('timeout', 'The search service did not answer in time.');
        if (signal.aborted) throw new GeocodeError('aborted', 'Search cancelled.');
        throw new GeocodeError('network', 'SmartTraffic could not be reached.');
      } finally {
        clearTimeout(timer);
      }
    },

    cancel() {
      if (controller) controller.abort();
    },
  };
}
