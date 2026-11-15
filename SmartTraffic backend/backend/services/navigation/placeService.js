const { TtlCache } = require('../../utils/ttlCache');
const { UpstreamError } = require('../../utils/upstream');
const { isValidLatLng } = require('../../utils/geo');
const { ApiError } = require('../../utils/apiError');
const { PLACE_CATEGORIES } = require('../../models/navigationConstants');

/**
 * Place search, reverse geocoding and nearby places from Geoapify, plus Hawr's own
 * local places (the operator's database, searched first).
 *
 *   search   GET /v1/geocode/search   text, filter=countrycode:iq, bias=proximity:lng,lat
 *   reverse  GET /v1/geocode/reverse  lat, lon
 *   nearby   GET /v2/places           categories, filter=circle:lng,lat,radius, bias=proximity
 *
 * Place (what the API returns):
 *   { id: "geoapify:<place_id>" | "hawr:<id>", name, address, lat, lng, category, type, source,
 *     addressDetails: { road, houseNumber, suburb, city, state, postcode, country, countryCode } | null }
 * `type` is Geoapify's result type (city, street, amenity, ...). Fields the provider
 * does not give are null, never guessed.
 *
 * Language: no `lang` is sent for search, because a language parameter changes what is
 * matched (a Latin query for a Kurdish street name stops finding it). The name shown is
 * chosen from the provider's own `other_names` (name:ar, name:ckb, name:en) and falls
 * back to the local name. The provider's raw answer is cached in memory
 * (PLACES_CACHE_TTL_SECONDS) and the language is applied when it is read, so readers of
 * every language share one provider request.
 */

const PROVIDER = 'Map provider';
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Language tag ("en-US,ar;q=0.8", "ku") -> 'ar' | 'en' | 'ku' | null. */
function preferredLang(tag) {
  const first = String(tag || '').split(',')[0].split(';')[0].trim().toLowerCase().split('-')[0];
  if (first === 'ckb') return 'ku';
  return ['ar', 'en', 'ku'].includes(first) ? first : null;
}

/** Name in the preferred language from Geoapify's other_names / name_international, else the local name. */
function pickName(props, lang) {
  const sources = [props.other_names, props.name_international].filter((o) => o && typeof o === 'object');
  // other_names.name is the name in the place's own script (Sorani Kurdish in Sulaymaniyah), which an Arabic or
  // Kurdish reader can read when no name in their own language exists. English never falls back to it.
  const keys = { ar: ['name:ar', 'ar', 'name'], en: ['name:en', 'en'], ku: ['name:ckb', 'ckb', 'name:ku', 'ku', 'name'] }[lang] || [];
  for (const source of sources) {
    for (const k of keys) {
      const v = text(source[k]);
      if (v) return v;
    }
  }
  return text(props.name);
}

function unexpected() {
  return new UpstreamError('PROVIDER_ERROR', `${PROVIDER} returned an unexpected answer`, { provider: PROVIDER });
}

const point = (props) => ({ lat: props.lat, lng: props.lon });
const hasPosition = (p) => typeof p.lat === 'number' && typeof p.lng === 'number' && isValidLatLng(p);

function addressDetails(p) {
  return {
    road: text(p.street),
    houseNumber: text(p.housenumber),
    suburb: text(p.suburb) || text(p.district),
    city: text(p.city),
    state: text(p.state),
    postcode: text(p.postcode),
    country: text(p.country),
    countryCode: text(p.country_code),
  };
}

/** One Geoapify geocoder feature -> Place, or null when it has no usable position or nothing to show. */
function toPlace(feature, lang) {
  const p = feature && feature.properties;
  if (!p || typeof p !== 'object') return null;
  const where = point(p);
  if (!hasPosition(where)) return null;
  const name = pickName(p, lang) || text(p.address_line1) || text(p.formatted);
  if (!name) return null;
  const formatted = text(p.formatted);
  return {
    id: `geoapify:${p.place_id || `${where.lat},${where.lng}`}`,
    name,
    address: formatted && formatted !== name ? formatted : null,
    ...where,
    category: text(p.category),
    type: text(p.result_type),
    source: 'geoapify',
    addressDetails: addressDetails(p),
  };
}

/** One Geoapify Places feature -> NearbyPlace for our category `key`, or null. */
function toNearbyPlace(feature, key, lang) {
  const p = feature && feature.properties;
  if (!p || typeof p !== 'object') return null;
  const where = point(p);
  if (!hasPosition(where)) return null;
  const categories = Array.isArray(p.categories) ? p.categories.filter((c) => typeof c === 'string') : [];
  return {
    id: `geoapify:${p.place_id}`,
    name: pickName(p, lang),
    category: key,
    providerCategory: categories.length ? categories[categories.length - 1] : null,
    ...where,
    distanceMeters: Math.round(Number(p.distance) || 0),
    rating: null,
    reviewCount: 0,
    openingHours: null,
    // Keys of the earlier answers, kept so existing apps do not break; Geoapify gives none of this.
    address: text(p.formatted),
    details: { brand: null, operator: null, openingHours: null, phone: null, website: null },
    url: null,
  };
}

function createPlaceService({
  client, config, localPlaces = null, now = Date.now,
}) {
  const enabled = client.enabled;
  const cache = new TtlCache({ maxEntries: 2000, ttlMs: config.cacheTtlSeconds * 1000, now });
  const stats = { cacheHits: 0 };

  function requireEnabled() {
    if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'Place search is disabled: the search provider is not configured (GEOAPIFY_API_KEY)');
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

  return {
    enabled,

    /**
     * Search by name: Hawr's local places first, then Geoapify (biased towards `near`, Iraq only).
     * Resolves { places, scope: 'local' (ranked near a point) | 'global', cached }.
     */
    async search({
      q, near = null, limit = 5, lang = null,
    }) {
      requireEnabled();
      const l = preferredLang(lang);
      const key = `s|${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : '-'}|${limit}`;
      const raw = await cached(key, async () => {
        const json = await client.get('/v1/geocode/search', {
          text: q, limit: String(limit), filter: 'countrycode:iq', ...(near ? { bias: `proximity:${near.lng},${near.lat}` } : {}),
        });
        if (!json || !Array.isArray(json.features)) throw unexpected();
        return { features: json.features };
      });
      const found = raw.features.map((f) => toPlace(f, l)).filter(Boolean);
      // Local places are the operator's own data and may change at any time: never cached here.
      const own = localPlaces ? await localPlaces.search({ q, limit, lang: l }).catch(() => []) : [];
      return { places: [...own, ...found].slice(0, limit), scope: near ? 'local' : 'global', cached: raw.cached };
    },

    /** Address at a point. Resolves { place: Place | null, cached }. */
    async reverse({ lat, lng, lang = null }) {
      requireEnabled();
      const l = preferredLang(lang);
      // ~11 m grid: taps on the same spot share one provider request.
      const key = `r|${lat.toFixed(4)},${lng.toFixed(4)}`;
      const raw = await cached(key, async () => {
        const json = await client.get('/v1/geocode/reverse', { lat: String(lat), lon: String(lng) });
        if (!json || !Array.isArray(json.features)) throw unexpected();
        return { feature: json.features[0] || null };
      });
      const place = toPlace(raw.feature, l);
      // The tapped point, not the point of the nearest address, is where the pin is.
      return { place: place ? { ...place, lat, lng } : null, cached: raw.cached };
    },

    /** Places around a point, nearest first, of one of our categories. */
    async nearby({
      lat, lng, category, radius, limit, lang = null,
    }) {
      requireEnabled();
      const l = preferredLang(lang);
      const key = `n|${lat.toFixed(3)},${lng.toFixed(3)}|${radius}|${category}|${limit}`;
      const raw = await cached(key, async () => {
        // 1 credit for up to 20 places, one more for every further 20.
        const cost = 1 + Math.ceil(Math.max(0, limit - 20) / 20);
        const json = await client.get('/v2/places', {
          categories: PLACE_CATEGORIES[category].join(','),
          filter: `circle:${lng},${lat},${radius}`,
          bias: `proximity:${lng},${lat}`,
          limit: String(limit),
        }, { cost });
        if (!json || !Array.isArray(json.features)) throw unexpected();
        return { features: json.features };
      });
      return { places: raw.features.map((f) => toNearbyPlace(f, category, l)).filter(Boolean), cached: raw.cached };
    },

    status() {
      return { enabled, provider: enabled ? 'geoapify' : null, cacheEntries: cache.size, ...stats };
    },
  };
}

module.exports = {
  createPlaceService, toPlace, toNearbyPlace, preferredLang, pickName,
};
