const express = require('express');
const { OsmError } = require('../services/osmProxyService');
const { parseBBox } = require('../controllers/hazardController');

const STATUS_FOR = { invalid: 400, 'too-large': 400, upstream: 502 };

/** GET /api/osm/:layer?south=&west=&north=&east=  ->  Overpass JSON { elements }. */
function createOsmRoutes(osm) {
  const router = express.Router();
  router.get('/osm/:layer', async (req, res) => {
    const bbox = parseBBox(req.query);
    if (!bbox) return res.status(400).json({ ok: false, error: 'south, west, north and east must be valid coordinates' });
    try {
      const json = await osm.fetchLayer(req.params.layer, bbox);
      res.set('Cache-Control', 'public, max-age=300');
      return res.json(json);
    } catch (err) {
      if (err instanceof OsmError) return res.status(STATUS_FOR[err.code]).json({ ok: false, error: err.message });
      console.error('[osm] request failed:', err);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });
  return router;
}

module.exports = { createOsmRoutes };
