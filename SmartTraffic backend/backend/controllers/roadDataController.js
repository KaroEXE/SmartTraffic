const {
  parseBBox, parseList, parseInteger, checkObjectId, validateFeatureInput, validateReportInput, validateVote, validateModeration,
} = require('../utils/navValidation');
const { invalid, sendError, ApiError } = require('../utils/apiError');
const {
  FEATURE_KINDS, OSM_FEATURE_KINDS, REPORT_TYPES, LIMITS,
} = require('../models/navigationConstants');
const { OSM_ATTRIBUTION } = require('./navigationController');

/**
 * HTTP layer for road features and community reports (/api/v1).
 * Authentication (device token / NAV_ADMIN_TOKEN) is applied by
 * routes/navigationRoutes.js.
 *
 *   GET    /road-features              public: operator + OpenStreetMap features in a box
 *   GET    /road-features/:id          public
 *   POST   /road-features              admin
 *   PATCH  /road-features/:id          admin
 *   DELETE /road-features/:id          admin
 *   GET    /reports                    public (device token optional: adds mine / myVote)
 *   GET    /reports/:id                public (device token optional)
 *   POST   /reports                    device
 *   POST   /reports/:id/votes          device
 *   DELETE /reports/:id                device (own report: withdraw)
 *   PATCH  /reports/:id                admin (moderation)
 */

const SOURCES = ['operator', 'osm'];

function unwrap(parsed) {
  if (parsed.errors) throw invalid(parsed.errors[0], parsed.errors);
  return parsed.value;
}

function requireId(req) {
  if (!checkObjectId(req.params.id)) throw invalid('id must be a 24-character hexadecimal id');
  return req.params.id;
}

function requireJson(req) {
  if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
}

function createRoadDataController({ roadFeatures, roadReports, overpass, log = console }) {
  return {
    /**
     * GET /road-features?south=&west=&north=&east=&kinds=&sources=
     * Operator features and OpenStreetMap features together. A source that
     * fails is reported in `sources` and the others are still returned;
     * 503 only when every requested source failed.
     */
    async listFeatures(req, res) {
      const bbox = unwrap(parseBBox(req.query));
      const kinds = unwrap(parseList(req.query.kinds, FEATURE_KINDS, 'kinds'));
      const sources = unwrap(parseList(req.query.sources, SOURCES, 'sources')) || SOURCES;
      const status = {};
      const features = [];
      let truncated = false;

      const jobs = [];
      if (sources.includes('operator')) {
        jobs.push(roadFeatures.findInBBox(bbox, { kinds }).then((r) => {
          status.operator = 'ok';
          features.push(...r.features);
          truncated = truncated || r.truncated;
        }, (err) => {
          status.operator = err.code === 'DATABASE_UNAVAILABLE' ? 'unavailable' : 'error';
          if (status.operator === 'error') log.warn(`[navigation] operator road features failed: ${err.message}`);
        }));
      }
      const osmKinds = (kinds || OSM_FEATURE_KINDS).filter((k) => OSM_FEATURE_KINDS.includes(k));
      if (sources.includes('osm')) {
        if (!overpass.enabled) status.osm = 'disabled';
        else if (!osmKinds.length) status.osm = 'not-requested';
        else {
          jobs.push(overpass.roadFeatures(bbox).then((r) => {
            status.osm = 'ok';
            features.push(...r.features.filter((f) => osmKinds.includes(f.kind)));
            truncated = truncated || r.truncated;
          }, (err) => {
            status.osm = 'unavailable';
            log.warn(`[navigation] OpenStreetMap road features failed: ${err.code || err.message}`);
          }));
        }
      }
      await Promise.all(jobs);

      const attempted = Object.values(status).filter((s) => s !== 'disabled' && s !== 'not-requested');
      if (attempted.length && attempted.every((s) => s !== 'ok')) {
        return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Road feature data is unavailable right now', { extra: { sources: status } });
      }
      const limited = features.slice(0, LIMITS.maxListResults);
      return res.json({
        ok: true,
        bbox,
        count: limited.length,
        truncated: truncated || features.length > limited.length,
        sources: status,
        features: limited,
        ...(status.osm === 'ok' ? { attribution: OSM_ATTRIBUTION } : {}),
      });
    },

    async getFeature(req, res) {
      res.json({ ok: true, feature: await roadFeatures.get(requireId(req)) });
    },

    async createFeature(req, res) {
      requireJson(req);
      const input = unwrap(validateFeatureInput(req.body));
      res.status(201).json({ ok: true, feature: await roadFeatures.create(input) });
    },

    async updateFeature(req, res) {
      const id = requireId(req);
      requireJson(req);
      const changes = unwrap(validateFeatureInput(req.body, { partial: true }));
      res.json({ ok: true, feature: await roadFeatures.update(id, changes) });
    },

    async deleteFeature(req, res) {
      const feature = await roadFeatures.remove(requireId(req));
      res.json({ ok: true, deleted: feature.id, feature });
    },

    /** GET /reports?south=&west=&north=&east=&types=&limit= */
    async listReports(req, res) {
      const bbox = unwrap(parseBBox(req.query));
      const types = unwrap(parseList(req.query.types, REPORT_TYPES, 'types'));
      const limit = unwrap(parseInteger(req.query.limit, 'limit', { min: 1, max: LIMITS.maxListResults, fallback: 200 }));
      const result = await roadReports.findInBBox(bbox, { types, limit, device: req.device || null });
      res.set('Cache-Control', 'no-cache');
      res.json({
        ok: true, bbox, count: result.reports.length, truncated: result.truncated, reports: result.reports,
      });
    },

    async getReport(req, res) {
      res.json({ ok: true, report: await roadReports.get(requireId(req), req.device || null) });
    },

    async createReport(req, res) {
      requireJson(req);
      const input = unwrap(validateReportInput(req.body));
      const { report, merged } = await roadReports.create(input, req.device);
      res.status(merged ? 200 : 201).json({ ok: true, merged, report });
    },

    async voteReport(req, res) {
      const id = requireId(req);
      requireJson(req);
      const { vote } = unwrap(validateVote(req.body));
      res.json({ ok: true, report: await roadReports.vote(id, vote, req.device) });
    },

    async withdrawReport(req, res) {
      res.json({ ok: true, report: await roadReports.withdraw(requireId(req), req.device) });
    },

    async moderateReport(req, res) {
      const id = requireId(req);
      requireJson(req);
      const changes = unwrap(validateModeration(req.body));
      res.json({ ok: true, report: await roadReports.moderate(id, changes) });
    },
  };
}

module.exports = { createRoadDataController };
