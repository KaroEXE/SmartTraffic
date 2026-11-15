const { parseInteger, parseList } = require('../utils/navValidation');
const { invalid } = require('../utils/apiError');
const {
  FEATURE_KINDS, REPORT_TYPES, PUBLIC_REPORT_STATUSES, LOCAL_PLACE_CATEGORIES,
} = require('../models/navigationConstants');

/**
 * Read-only operator views for the admin console (admin.html), all behind
 * NAV_ADMIN_TOKEN (routes/navigationRoutes.js):
 *
 *   GET /api/v1/admin/overview        system health, live traffic feed, counts
 *   GET /api/v1/admin/users           accounts (email, name, created); never password data
 *   GET /api/v1/admin/reports         driver reports in any status
 *   GET /api/v1/admin/road-features   operator road features, active or not
 *   GET /api/v1/admin/places          Hawr's own local places, active or not
 *
 * Changes use the existing endpoints: PATCH /reports/:id (moderation) and
 * POST / PATCH / DELETE /road-features.
 */

const PAGE_SIZE_MAX = 100;
const EMAIL_PREFIX = /^[A-Za-z0-9@._+-]{1,80}$/;

function unwrap(parsed) {
  if (parsed.errors) throw invalid(parsed.errors[0], parsed.errors);
  return parsed.value;
}

function paging(query) {
  return {
    page: unwrap(parseInteger(query.page, 'page', { min: 1, max: 100000, fallback: 1 })),
    limit: unwrap(parseInteger(query.limit, 'limit', { min: 1, max: PAGE_SIZE_MAX, fallback: 25 })),
  };
}

/** A section of the overview whose data lives in the database: unavailable, not invented, without one. */
async function section(load) {
  try {
    return { available: true, ...(await load()) };
  } catch (err) {
    if (err.code === 'DATABASE_UNAVAILABLE') return { available: false };
    throw err;
  }
}

function createAdminController({
  userAccounts, roadReports, roadFeatures, localPlaces, liveTraffic, health, now = Date.now,
}) {
  return {
    /** GET /admin/overview */
    async overview(req, res) {
      const t = now();
      const intersections = liveTraffic.list().intersections;
      const count = (status) => intersections.filter((i) => i.status === status).length;
      const [users, reports, features, places] = await Promise.all([
        section(() => userAccounts.stats(new Date(t - 7 * 86_400_000))),
        section(() => roadReports.counts()),
        section(() => roadFeatures.counts()),
        section(() => localPlaces.counts()),
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        generatedAt: new Date(t).toISOString(),
        system: health(),
        traffic: {
          monitoredIntersections: intersections.length, live: count('live'), stale: count('stale'), noData: count('no-data'),
        },
        users,
        reports,
        roadFeatures: features,
        localPlaces: places,
      });
    },

    /** GET /admin/users?q=&page=&limit= - q: start of an email address */
    async listUsers(req, res) {
      const { page, limit } = paging(req.query);
      const raw = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      if (raw && !EMAIL_PREFIX.test(raw)) throw invalid('q must be the start of an email address (letters, digits and @ . _ + -)');
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...(await userAccounts.list({ q: raw || null, page, limit })) });
    },

    /** GET /admin/reports?status=&type=&page=&limit= */
    async listReports(req, res) {
      const { page, limit } = paging(req.query);
      const [status] = unwrap(parseList(req.query.status, PUBLIC_REPORT_STATUSES, 'status')) || [];
      const [type] = unwrap(parseList(req.query.type, REPORT_TYPES, 'type')) || [];
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...(await roadReports.list({ status, type, page, limit })) });
    },

    /** GET /admin/places?category=&active=&page=&limit= */
    async listPlaces(req, res) {
      const { page, limit } = paging(req.query);
      const [category] = unwrap(parseList(req.query.category, LOCAL_PLACE_CATEGORIES, 'category')) || [];
      let active;
      if (req.query.active !== undefined && req.query.active !== '') {
        if (!['true', 'false'].includes(req.query.active)) throw invalid('active must be true or false');
        active = req.query.active === 'true';
      }
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...(await localPlaces.list({ category, active, page, limit })) });
    },

    /** GET /admin/road-features?kind=&active=&page=&limit= */
    async listFeatures(req, res) {
      const { page, limit } = paging(req.query);
      const [kind] = unwrap(parseList(req.query.kind, FEATURE_KINDS, 'kind')) || [];
      let active;
      if (req.query.active !== undefined && req.query.active !== '') {
        if (!['true', 'false'].includes(req.query.active)) throw invalid('active must be true or false');
        active = req.query.active === 'true';
      }
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...(await roadFeatures.list({ kind, active, page, limit })) });
    },
  };
}

module.exports = { createAdminController, PAGE_SIZE_MAX };
