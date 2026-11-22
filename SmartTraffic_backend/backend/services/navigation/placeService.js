const { PLACE_CATEGORIES } = require('../../models/navigationConstants');
const { preferredLang } = require('../geo/geoService');

/**
 * Place search, reverse geocoding and nearby places of the mobile API (/api/v1/places/*), answered by
 * Redoz's own PostGIS database (services/geo) - there is no external search provider - plus the
 * operator's local places from MongoDB (LocalPlace), which are searched first.
 *
 * Place (what the API returns; the shape the apps already use):
 *   { id: "osm:<n|w|r|s|a><id>" | "redoz:<uuid>" | "hawr:<mongo id>", name, address, lat, lng, category, type, source,
 *     boundingBox, addressDetails: { road, houseNumber, suburb, city, state, postcode, country, countryCode } | null }
 * `type` is the kind of result (amenity, street, city, area, ...). Fields the data does not have are null.
 */

const TYPE_OF_ENTITY = { poi: 'amenity', street: 'street', area: 'area' };

function toPlace(r) {
  const d = r.addressDetails;
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    lat: r.latitude,
    lng: r.longitude,
    category: r.category,
    type: r.entity === 'settlement' ? r.type : (TYPE_OF_ENTITY[r.entity] || r.entity),
    source: r.source,
    boundingBox: r.boundingBox,
    addressDetails: d ? {
      road: d.road, houseNumber: d.houseNumber, suburb: d.suburb, city: d.city, state: d.state, postcode: d.postcode, country: d.country, countryCode: null,
    } : null,
  };
}

function toNearbyPlace(r, key) {
  const details = r.details || {};
  return {
    id: r.id,
    name: r.name,
    category: key,
    providerCategory: r.osmValue || null,
    lat: r.latitude,
    lng: r.longitude,
    distanceMeters: r.distanceMeters === null ? 0 : r.distanceMeters,
    rating: r.rating,
    reviewCount: r.ratingCount,
    openingHours: details.opening_hours || null,
    address: r.address,
    details: {
      brand: details.brand || null,
      operator: details.operator || null,
      openingHours: details.opening_hours || null,
      phone: details.phone || null,
      website: details.website || null,
    },
    url: null,
  };
}

function createPlaceService({ geo, localPlaces = null }) {
  return {
    enabled: geo.enabled,

    /**
     * Search by name: local (MongoDB) places first, then PostGIS (ranked, near `near` when given).
     * Resolves { places, scope: 'local' (ranked near a point) | 'global', cached: false }.
     */
    async search({
      q, near = null, limit = 5, lang = null,
    }) {
      const l = preferredLang(lang);
      const [found, own] = await Promise.all([
        geo.searchPlaces({
          q, near, limit, offset: 0, lang,
        }),
        // The operator's own data may change at any time and is never cached; a failure here never hides OSM results.
        localPlaces ? localPlaces.search({ q, limit, lang: l }).catch(() => []) : [],
      ]);
      return { places: [...own, ...found.results.map(toPlace)].slice(0, limit), scope: near ? 'local' : 'global', cached: false };
    },

    /** Address at a point. Resolves { place: Place | null, cached: false }. */
    async reverse({ lat, lng, lang = null }) {
      const r = await geo.reverseGeocode({ lat, lng, lang });
      if (!r.displayName) return { place: null, cached: false };
      let kind = 'locality';
      if (r.houseNumber) kind = 'building';
      else if (r.street) kind = 'street';
      return {
        place: {
          id: r.nearestRoad ? r.nearestRoad.id : `osm:point:${lat.toFixed(5)},${lng.toFixed(5)}`,
          name: (r.place && r.place.name) || r.street || r.neighbourhood || r.city || r.displayName,
          address: r.displayName,
          lat,
          lng,
          category: null,
          type: kind,
          source: 'osm',
          boundingBox: null,
          addressDetails: {
            road: r.street, houseNumber: r.houseNumber, suburb: r.neighbourhood, city: r.city, state: r.state, postcode: null, country: r.country, countryCode: null,
          },
        },
        cached: false,
      };
    },

    /** Places around a point, nearest first, of one of our categories. */
    async nearby({
      lat, lng, category, radius, limit, lang = null,
    }) {
      const places = await geo.findNearbyPlaces({
        lat, lng, radius, categories: PLACE_CATEGORIES[category], limit, lang,
      });
      return { places: places.map((p) => toNearbyPlace(p, category)), cached: false };
    },

    status() {
      return { enabled: geo.enabled, provider: geo.enabled ? 'postgis' : null };
    },
  };
}

module.exports = { createPlaceService, toPlace, toNearbyPlace };
