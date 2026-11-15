import { NAV_CONFIG } from './config.js';
import { isValidLatLng } from './geo.js';

/**
 * Destination search through the SmartTraffic backend
 * (GET /api/v1/places/search), which asks the search provider. Searches run on submit, not
 * on every key, and the backend caches answers and limits requests per client.
 *
 * Place: { id, name, address, lat, lng }
 */

export class GeocodeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // too-short | offline | network | timeout | provider | busy | aborted
  }
}

/** Backend answer { places: [...] } -> Place[]. Entries without a usable position are skipped. */
export function parsePlaces(json) {
  if (!json || !Array.isArray(json.places)) return [];
  const out = [];
  for (const p of json.places) {
    if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !isValidLatLng({ lat: p.lat, lng: p.lng })) continue;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : null;
    if (!name) continue;
    out.push({
      id: typeof p.id === 'string' ? p.id : `place-${out.length}`,
      name,
      address: typeof p.address === 'string' ? p.address : '',
      lat: p.lat,
      lng: p.lng,
    });
  }
  return out;
}

const BUSY_CODES = new Set(['RATE_LIMITED', 'PROVIDER_BUSY', 'PROVIDER_QUOTA_EXCEEDED']);

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
          if (json && json.code === 'FEATURE_DISABLED') throw new GeocodeError('provider', 'Search is not set up on this server.');
          throw new GeocodeError('provider', `The search service answered HTTP ${res.status}.`);
        }
        return { places: parsePlaces(json), scope: json && json.scope === 'local' ? 'local' : 'global' };
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
