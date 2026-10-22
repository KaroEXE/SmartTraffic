const { TtlCache } = require('../../utils/ttlCache');
const {
  requestJson, createThrottle, createCircuitBreaker, UpstreamError,
} = require('../../utils/upstream');
const { isValidLatLng } = require('../../utils/geo');
const { ApiError } = require('../../utils/apiError');

/**
 * Place search and reverse geocoding through a Nominatim-compatible API
 * (default: the public OpenStreetMap Nominatim; self-hosted Nominatim or a
 * compatible commercial service such as LocationIQ via GEOCODING_URL and
 * GEOCODING_API_KEY).
 *
 * The public instance allows about one request per second for this whole
 * server, requires an identifying User-Agent and asks for caching, so:
 * requests are spaced (utils/upstream.createThrottle), answers are cached
 * (GEOCODING_CACHE_TTL_SECONDS, default one day) and the app is expected to
 * search on submit, not on every keystroke.
 *
 * Place (what the API returns):
 *   { id: "osm:node:123", name, address, lat, lng, category, type,
 *     addressDetails: { road, houseNumber, suburb, city, state, postcode, country, countryCode } | null }
 */

const PROVIDER = 'Geocoding provider';

function placeId(r, i) {
  return r.osm_type && r.osm_id ? `osm:${r.osm_type}:${r.osm_id}` : `place:${r.place_id || i}`;
}

function addressDetails(a) {
  if (!a || typeof a !== 'object') return null;
  const pick = (...keys) => keys.map((k) => a[k]).find((v) => typeof v === 'string' && v) || null;
  return {
    road: pick('road', 'pedestrian', 'footway'),
    houseNumber: pick('house_number'),
    suburb: pick('suburb', 'neighbourhood', 'quarter'),
    city: pick('city', 'town', 'village', 'municipality'),
    state: pick('state', 'province', 'region'),
    postcode: pick('postcode'),
    country: pick('country'),
    countryCode: pick('country_code'),
  };
}

/** One Nominatim jsonv2 result -> Place, or null when it has no usable position. */
function toPlace(r, i = 0) {
  if (!r || typeof r !== 'object') return null;
  const lat = Number.parseFloat(r.lat);
  const lng = Number.parseFloat(r.lon);
  if (!isValidLatLng({ lat, lng })) return null;
  const display = typeof r.display_name === 'string' ? r.display_name : '';
  return {
    id: placeId(r, i),
    name: (typeof r.name === 'string' && r.name) || display.split(',')[0].trim() || 'Unnamed place',
    address: display || null,
    lat,
    lng,
    category: typeof r.category === 'string' ? r.category : (typeof r.class === 'string' ? r.class : null),
    type: typeof r.type === 'string' ? r.type : null,
    addressDetails: addressDetails(r.address),
  };
}

function parseSearch(json) {
  if (!Array.isArray(json)) throw new UpstreamError('PROVIDER_ERROR', `${PROVIDER} returned an unexpected answer`, { provider: PROVIDER });
  return json.map(toPlace).filter(Boolean);
}

/** Search box around `near`, at least `spanDeg` wide. */
function localBox(near, spanDeg) {
  const half = spanDeg / 2;
  return {
    west: Math.max(-180, near.lng - half),
    north: Math.min(90, near.lat + half),
    east: Math.min(180, near.lng + half),
    south: Math.max(-90, near.lat - half),
  };
}

function createGeocodingService({
  config, userAgent, maxWaitMs = 8000, cooldownMs = 30_000, fetchImpl = globalThis.fetch, now = Date.now,
}) {
  const cfg = config;
  const enabled = Boolean(cfg.url);
  const cache = new TtlCache({ maxEntries: 2000, ttlMs: cfg.cacheTtlSeconds * 1000, now });
  const throttle = createThrottle({ minIntervalMs: cfg.minIntervalMs, maxWaitMs, provider: PROVIDER, now });
  const breaker = createCircuitBreaker({
    provider: PROVIDER, failureThreshold: 3, cooldownMs, now,
  });
  const stats = { requests: 0, cacheHits: 0, failures: 0, lastError: null, lastErrorAt: null };

  function requireEnabled() {
    if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'Place search is disabled on this server (GEOCODING_URL=off)');
  }

  async function call(path, params) {
    const search = new URLSearchParams({ format: 'jsonv2', ...params });
    if (cfg.apiKey) search.set('key', cfg.apiKey);
    if (cfg.contactEmail) search.set('email', cfg.contactEmail);
    breaker.check();
    stats.requests += 1;
    try {
      const { status, json } = await throttle.schedule(() => requestJson(`${cfg.url}${path}?${search}`, {
        provider: PROVIDER, timeoutMs: cfg.timeoutMs, userAgent, fetchImpl,
      }));
      if (status >= 400) {
        throw new UpstreamError('PROVIDER_ERROR', `${PROVIDER} answered HTTP ${status}`, { provider: PROVIDER, status });
      }
      breaker.success();
      return json;
    } catch (err) {
      breaker.failure(err);
      stats.failures += 1;
      stats.lastError = err.code || 'PROVIDER_ERROR';
      stats.lastErrorAt = new Date(now()).toISOString();
      throw err;
    }
  }

  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      stats.cacheHits += 1;
      return { ...hit, cached: true };
    }
    const value = await load();
    cache.set(key, value);
    return { ...value, cached: false };
  }

  const common = (lang) => ({
    addressdetails: '1',
    ...(lang ? { 'accept-language': lang } : {}),
    ...(cfg.countryCodes ? { countrycodes: cfg.countryCodes } : {}),
  });

  return {
    enabled,

    /**
     * Searches near `near` first (bounded box), then without the bound if
     * nothing was found there. Resolves { places, scope: 'local' | 'global', cached }.
     */
    async search({ q, near = null, limit = 5, lang = null }) {
      requireEnabled();
      const key = `s|${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : '-'}|${limit}|${lang || '-'}`;
      return cached(key, async () => {
        const base = { q, limit: String(limit), ...common(lang) };
        if (near) {
          const box = localBox(near, cfg.localSpanDeg);
          const viewbox = `${box.west},${box.north},${box.east},${box.south}`;
          const local = parseSearch(await call('/search', { ...base, viewbox, bounded: '1' }));
          if (local.length) return { places: local, scope: 'local' };
          return { places: parseSearch(await call('/search', { ...base, viewbox })), scope: 'global' };
        }
        return { places: parseSearch(await call('/search', base)), scope: 'global' };
      });
    },

    /** Address at a point. Resolves { place: Place | null, cached }. */
    async reverse({ lat, lng, lang = null }) {
      requireEnabled();
      // ~11 m grid: taps on the same spot share one upstream request.
      const key = `r|${lat.toFixed(4)},${lng.toFixed(4)}|${lang || '-'}`;
      return cached(key, async () => {
        const json = await call('/reverse', {
          lat: String(lat), lon: String(lng), zoom: '18', ...common(lang),
        });
        // Nominatim answers { error: "Unable to geocode" } where there is no address.
        return { place: json && !json.error ? toPlace(json) : null };
      });
    },

    status() {
      return {
        enabled, provider: enabled ? 'nominatim-compatible' : null, cacheEntries: cache.size, ...breaker.state(), ...stats,
      };
    },
  };
}

module.exports = { createGeocodingService, toPlace, localBox };
