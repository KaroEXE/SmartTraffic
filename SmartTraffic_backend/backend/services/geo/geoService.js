const { ApiError } = require('../../utils/apiError');

/**
 * Redoz's own geographic service: place search, reverse geocoding, nearby places and roads, all
 * answered from PostgreSQL/PostGIS (OpenStreetMap data + Redoz-owned places). No external provider.
 * Rows from repositories/geoRepository.js become the API shapes here; nothing else knows the schema.
 *
 * Place (GET /api/search):
 *   { id: "osm:w123" | "redoz:<uuid>", name, type, category, latitude, longitude, address, source: "osm"|"redoz",
 *     entity: "poi"|"settlement"|"street"|"area", verified, distanceMeters|null, names: { default, ar, ckb, en },
 *     addressDetails, boundingBox|null }
 * `type` is the Redoz category (shopping_mall, hospital, fuel, street ...). Fields the data does not
 * have are null, never guessed.
 */

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Language tag ("en-US,ar;q=0.8", "ku", "ckb") -> 'ar' | 'en' | 'ku' | null. */
function preferredLang(tag) {
  const first = String(tag || '').split(',')[0].split(';')[0].trim().toLowerCase().split('-')[0];
  if (first === 'ckb') return 'ku';
  return ['ar', 'en', 'ku'].includes(first) ? first : null;
}

/** The name in the reader's language from OSM's name:xx tags, else the local name. */
function displayName(names, fallback, lang) {
  const n = names || {};
  const keys = { ar: ['name:ar'], en: ['name:en'], ku: ['name:ckb', 'name:ku'] }[lang] || [];
  for (const k of keys) {
    const v = text(n[k]);
    if (v) return v;
  }
  return text(fallback) || text(n.name) || text(n['name:ckb']) || text(n['name:ar']) || text(n['name:en']);
}

function nameSet(row) {
  const n = row.names || {};
  return {
    default: text(row.name) || text(n.name),
    ar: text(n['name:ar']),
    ckb: text(n['name:ckb']) || text(n['name:ku']),
    en: text(n['name:en']),
  };
}

function addressDetails(row) {
  const a = row.address || {};
  const details = {
    road: text(a.street),
    houseNumber: text(a.housenumber),
    suburb: text(a.suburb) || text(a.district),
    city: text(a.city) || text(row.city),
    state: text(a.state) || text(a.province) || text(row.state),
    postcode: text(a.postcode),
    country: text(a.country),
  };
  return Object.values(details).some((v) => v !== null) ? details : null;
}

function boundingBox(row) {
  const b = row.bbox;
  if (!b || ![b.south, b.west, b.north, b.east].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { south: b.south, west: b.west, north: b.north, east: b.east };
}

/** A search_entities row -> the public Place of GET /api/search. */
function toSearchResult(row, lang) {
  const name = displayName(row.names, row.name, lang);
  return {
    id: row.place_key,
    name,
    type: row.category,
    category: row.category,
    latitude: row.lat,
    longitude: row.lng,
    address: text(row.address_text),
    source: row.source,
    entity: row.entity,
    verified: Boolean(row.verified),
    distanceMeters: row.distance_m === null || row.distance_m === undefined ? null : Math.round(Number(row.distance_m)),
    names: nameSet(row),
    addressDetails: addressDetails(row),
    boundingBox: boundingBox(row),
  };
}

const roadName = (row, lang) => displayName(row.names, row.name, lang);

/** Public road: the facts a router or an app needs; the raw tags stay in the database. */
function toRoad(row, lang) {
  return {
    id: `osm:w${row.osm_id}`,
    osmWayId: Number(row.osm_id),
    name: roadName(row, lang),
    type: row.highway,
    ref: text(row.ref),
    oneway: text(row.oneway),
    maxspeed: text(row.maxspeed),
    lanes: text(row.lanes),
    surface: text(row.surface),
    access: text(row.access),
    junction: text(row.junction),
    bridge: text(row.bridge),
    tunnel: text(row.tunnel),
    distanceMeters: Math.round(Number(row.distance_m)),
  };
}

function createGeoService({ repository, enabled }) {
  function requireEnabled() {
    if (!enabled) throw new ApiError(503, 'FEATURE_DISABLED', 'Place search is disabled: the geographic database is not configured (DATABASE_URL)');
  }

  const service = {
    enabled,

    /**
     * Ranked search. Resolves { query, results, pagination: { limit, offset, count, hasMore } }.
     * `near` ({ lat, lng }) adds the distance to the ranking and to each result.
     */
    async searchPlaces({
      q, near = null, limit = 10, offset = 0, lang = null,
    }) {
      requireEnabled();
      const l = preferredLang(lang);
      // One extra row tells whether another page exists.
      const { rows } = await repository.searchPlaces({
        query: q, near, limit: limit + 1, offset,
      });
      const page = rows.slice(0, limit);
      return {
        query: q,
        results: page.map((r) => toSearchResult(r, l)),
        pagination: {
          limit, offset, count: page.length, hasMore: rows.length > limit,
        },
      };
    },

    /** Places of our categories around a point, nearest first. */
    async findNearbyPlaces({
      lat, lng, radius, categories, limit, lang = null,
    }) {
      requireEnabled();
      const l = preferredLang(lang);
      const rows = await repository.findNearbyPlaces({
        lat, lng, radius, categories, limit,
      });
      return rows.map((r) => ({ ...toSearchResult(r, l), details: r.details || {}, rating: r.rating === null || r.rating === undefined ? null : Number(r.rating), ratingCount: r.rating_count || 0, osmValue: r.type }));
    },

    async findPlacesInBBox({
      south, west, north, east, categories = null, limit = 100, lang = null,
    }) {
      requireEnabled();
      const l = preferredLang(lang);
      const rows = await repository.findPlacesInBBox({
        south, west, north, east, categories, limit,
      });
      return rows.map((r) => toSearchResult(r, l));
    },

    async findNearbyRoads({
      lat, lng, radius = 200, limit = 10, namedOnly = false, lang = null,
    }) {
      requireEnabled();
      const l = preferredLang(lang);
      return (await repository.findNearbyRoads({
        lat, lng, radius, limit, namedOnly,
      })).map((r) => toRoad(r, l));
    },

    async findNearestRoad({
      lat, lng, radius = 200, namedOnly = false, lang = null,
    }) {
      requireEnabled();
      const row = await repository.findNearestRoad({
        lat, lng, radius, namedOnly,
      });
      return row ? toRoad(row, preferredLang(lang)) : null;
    },

    async distanceMeters(a, b) {
      requireEnabled();
      return repository.distanceMeters(a, b);
    },

    /**
     * What is at a point: street, house number, neighbourhood, district, city, governorate, country and
     * the named place right there, from the address points, roads, administrative polygons and
     * settlements in the database. Fields with no data are null. Resolves
     * { latitude, longitude, displayName, street, houseNumber, neighbourhood, district, city, state,
     *   country, nearestRoad, place }.
     */
    async reverseGeocode({ lat, lng, lang = null }) {
      requireEnabled();
      const l = preferredLang(lang);
      const [address, road, areas, cities, neighbourhoods, poi] = await Promise.all([
        repository.findNearestAddress({ lat, lng, radius: 40 }),
        repository.findNearestRoad({
          lat, lng, radius: 120, namedOnly: true,
        }),
        repository.findAdminAreasAt({ lat, lng }),
        repository.findNearestSettlements({
          lat, lng, types: ['city', 'town', 'village'], radius: 25_000, limit: 1,
        }),
        repository.findNearestSettlements({
          lat, lng, types: ['suburb', 'neighbourhood', 'quarter'], radius: 1500, limit: 1,
        }),
        repository.findNearestPoi({ lat, lng, radius: 30 }),
      ]);

      const area = (...levels) => {
        const found = areas.find((a) => levels.includes(a.admin_level));
        return found ? displayName(found.names, found.name, l) : null;
      };
      const settlement = (list) => (list[0] ? displayName(list[0].names, list[0].name, l) : null);

      const street = text(address && address.street) || (road ? roadName(road, l) : null);
      const houseNumber = address && address.street ? text(address.housenumber) : null;
      const neighbourhood = area(10, 9) || settlement(neighbourhoods);
      const district = area(6, 5);
      const city = area(8, 7) || settlement(cities) || district;
      const state = area(4);
      const country = area(2);

      const parts = [
        [street, houseNumber].filter(Boolean).join(' '),
        neighbourhood, city, state, country,
      ].filter(Boolean);
      const deduped = parts.filter((p, i) => p !== parts[i - 1]);

      return {
        latitude: lat,
        longitude: lng,
        displayName: deduped.length ? deduped.join(', ') : null,
        street,
        houseNumber,
        neighbourhood,
        district,
        city,
        state,
        country,
        nearestRoad: road ? toRoad(road, l) : null,
        place: poi ? { id: poi.place_key, name: displayName(poi.names, poi.name, l), type: poi.category, distanceMeters: Math.round(Number(poi.distance_m)) } : null,
      };
    },
  };
  return service;
}

module.exports = {
  createGeoService, toSearchResult, toRoad, displayName, preferredLang, addressDetails,
};
