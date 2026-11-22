const { validateGeoSearchQuery, parseLanguage, parseQueryPoint } = require('../utils/navValidation');
const { invalid } = require('../utils/apiError');

/**
 * HTTP layer of Redoz's own geographic API (PostGIS):
 *
 *   GET /api/search?q=&lat=&lng=&limit=&offset=&lang=
 *   GET /api/geocode/reverse?lat=&lng=&lang=
 *
 * Success answers are { ok: true, ... }, errors { ok: false, code, error, details? } like every other
 * endpoint (utils/apiError.js). Results come from OpenStreetMap, which requires the attribution
 * below wherever they are shown (ODbL).
 */

const OSM_ATTRIBUTION = {
  text: '© OpenStreetMap contributors',
  url: 'https://www.openstreetmap.org/copyright',
  provider: 'OpenStreetMap',
};

function unwrap(parsed) {
  if (parsed.errors) throw invalid(parsed.errors[0], parsed.errors);
  return parsed.value;
}

function createGeoController({ geo }) {
  return {
    /** GET /api/search */
    async search(req, res) {
      const { q, near, limit, offset } = unwrap(validateGeoSearchQuery(req.query));
      const lang = unwrap(parseLanguage(req));
      const found = await geo.searchPlaces({
        q, near, limit, offset, lang,
      });
      res.set('Cache-Control', 'private, max-age=30');
      res.json({
        ok: true, query: found.query, count: found.results.length, results: found.results, pagination: found.pagination, attribution: OSM_ATTRIBUTION,
      });
    },

    /** GET /api/geocode/reverse */
    async reverse(req, res) {
      const point = unwrap(parseQueryPoint(req.query));
      const lang = unwrap(parseLanguage(req));
      const found = await geo.reverseGeocode({ ...point, lang });
      res.set('Cache-Control', 'private, max-age=30');
      res.json({ ok: true, ...found, attribution: OSM_ATTRIBUTION });
    },
  };
}

module.exports = { createGeoController, OSM_ATTRIBUTION };
