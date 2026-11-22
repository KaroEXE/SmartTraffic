const { ID_PATTERN } = require('../utils/validation');
const { validateStreamInput, validateHealthReport } = require('../utils/streamValidation');

/**
 * HTTP layer for camera streams (services/streamRegistryService.js).
 * Authentication is applied by the routes (routes/trafficRoutes.js).
 *
 *   GET    /api/streams            full records incl. URL       ingest or admin token
 *   GET    /api/streams/status     dashboard status, no URLs    public
 *   POST   /api/streams/health     AI health report             ingest or admin token
 *   GET    /api/streams/:id        one full record              ingest or admin token
 *   POST   /api/streams            register                     admin token
 *   PATCH  /api/streams/:id        update settings / enable     admin token
 *   DELETE /api/streams/:id        remove                       admin token
 */
function createStreamController(registry, { hasIntersection = () => true, secrets = [] } = {}) {
  function fail(res, err, action) {
    const code = err && err.code;
    if (code === 'DB_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: 'Stream registry unavailable: the database is not connected' });
    }
    if (code === 'NOT_FOUND') return res.status(404).json({ ok: false, error: err.message });
    if (code === 'DUPLICATE') return res.status(409).json({ ok: false, error: err.message });
    if (err && err.name === 'ValidationError') {
      return res.status(400).json({ ok: false, error: 'Invalid stream', details: Object.values(err.errors || {}).map((e) => e.message) });
    }
    console.error(`[streams] ${action} failed: ${err && err.message}`);
    return res.status(500).json({ ok: false, error: `Could not ${action}` });
  }

  function validId(req, res) {
    if (ID_PATTERN.test(req.params.id)) return true;
    res.status(400).json({ ok: false, error: 'stream id must be 1-64 characters [A-Za-z0-9_-]' });
    return false;
  }

  return {
    async list(req, res) {
      const { enabled, intersectionId } = req.query;
      const options = {};
      if (enabled !== undefined) {
        if (enabled !== 'true' && enabled !== 'false') return res.status(400).json({ ok: false, error: 'enabled must be true or false' });
        options.enabled = enabled === 'true';
      }
      if (intersectionId !== undefined) {
        if (typeof intersectionId !== 'string' || !ID_PATTERN.test(intersectionId)) {
          return res.status(400).json({ ok: false, error: 'intersectionId is not valid' });
        }
        options.intersectionId = intersectionId;
      }
      try {
        const streams = await registry.list(options);
        return res.json({ ok: true, count: streams.length, streams });
      } catch (err) { return fail(res, err, 'list streams'); }
    },

    status(req, res) {
      res.json({ ok: true, ...registry.publicList() });
    },

    async get(req, res) {
      if (!validId(req, res)) return undefined;
      try {
        return res.json({ ok: true, stream: await registry.get(req.params.id) });
      } catch (err) { return fail(res, err, 'read stream'); }
    },

    async create(req, res) {
      if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
      const result = validateStreamInput(req.body, { hasIntersection });
      if (!result.ok) return res.status(400).json({ ok: false, error: 'Invalid stream', details: result.errors });
      try {
        return res.status(201).json({ ok: true, stream: await registry.create(result.value) });
      } catch (err) { return fail(res, err, 'register stream'); }
    },

    async update(req, res) {
      if (!validId(req, res)) return undefined;
      if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
      const result = validateStreamInput(req.body, { partial: true, hasIntersection });
      if (!result.ok) return res.status(400).json({ ok: false, error: 'Invalid stream update', details: result.errors });
      try {
        return res.json({ ok: true, stream: await registry.update(req.params.id, result.value) });
      } catch (err) { return fail(res, err, 'update stream'); }
    },

    async remove(req, res) {
      if (!validId(req, res)) return undefined;
      try {
        await registry.remove(req.params.id);
        return res.json({ ok: true, deleted: req.params.id });
      } catch (err) { return fail(res, err, 'remove stream'); }
    },

    async health(req, res) {
      if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
      const result = validateHealthReport(req.body);
      if (!result.ok) return res.status(400).json({ ok: false, error: 'Invalid health report', details: result.errors });
      try {
        const outcome = await registry.reportHealth(result.value, { secrets });
        return res.json({
          ok: true,
          updated: outcome.updated.length,
          ignored: outcome.ignored,
          rejected: result.value.rejected,
          persisted: outcome.persisted,
        });
      } catch (err) { return fail(res, err, 'record stream health'); }
    },
  };
}

module.exports = { createStreamController };
