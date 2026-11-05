const crypto = require('crypto');
const { HazardReportError } = require('../services/hazardReportService');
const { HAZARD_REPORT_STATUSES } = require('../models/constants');

/**
 * HTTP handlers for driver road reports.
 *
 * Public:  POST /api/hazards/reports   - submit a report (stored as pending)
 *          GET  /api/hazards?bbox      - approved reports only
 * Admin:   /api/admin/hazard-reports   - review queue; needs
 *          "Authorization: Bearer <ADMIN_TOKEN>". Without ADMIN_TOKEN the
 *          admin API is disabled, so nothing reported is ever published.
 */

const STATUS_FOR = { invalid: 400, 'not-found': 404, full: 503 };
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function sendError(res, err) {
  if (err instanceof HazardReportError) return res.status(STATUS_FOR[err.code] || 400).json({ ok: false, error: err.message });
  console.error('[hazard-reports] request failed:', err);
  return res.status(500).json({ ok: false, error: 'Could not save the report. Please try again.' });
}

/** Fixed-window limit per client address, so one client cannot flood the review queue. */
function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (key) => {
    const t = now();
    if (hits.size > 10000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) { hits.set(key, { count: 1, resetAt: t + windowMs }); return true; }
    entry.count += 1;
    return entry.count <= max;
  };
}

function parseBBox(q) {
  const box = {};
  for (const k of ['south', 'west', 'north', 'east']) {
    if (q[k] === undefined || q[k] === '') return null;
    const v = Number(q[k]);
    if (!Number.isFinite(v)) return null;
    box[k] = v;
  }
  const latOk = box.south >= -90 && box.north <= 90 && box.south <= box.north;
  const lngOk = box.west >= -180 && box.east <= 180 && box.west <= box.east;
  return latOk && lngOk ? box : null;
}

function createHazardController(reports, { adminToken, reportLimit = { max: 5, windowMs: 10 * 60 * 1000 } } = {}) {
  const allowReport = createRateLimiter(reportLimit);
  const tokenDigest = adminToken ? digest(adminToken) : null;

  return {
    requireAdmin(req, res, next) {
      if (!tokenDigest) return res.status(503).json({ ok: false, error: 'Report review is disabled: set ADMIN_TOKEN in backend/.env' });
      const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      if (!match || !crypto.timingSafeEqual(digest(match[1].trim()), tokenDigest)) {
        return res.status(401).json({ ok: false, error: 'Admin token missing or wrong' });
      }
      return next();
    },

    async submitReport(req, res) {
      if (!allowReport(req.ip || 'unknown')) {
        return res.status(429).json({ ok: false, error: 'Too many reports from this device. Please wait a few minutes.' });
      }
      try {
        const report = await reports.create(req.body);
        res.status(201).json({ ok: true, report: { id: report.id, status: report.status } });
      } catch (err) {
        sendError(res, err);
      }
    },

    listApproved(req, res) {
      const bbox = parseBBox(req.query);
      if (!bbox) return res.status(400).json({ ok: false, error: 'south, west, north and east must be valid coordinates' });
      return res.json({ ok: true, hazards: reports.listApproved(bbox) });
    },

    listForReview(req, res) {
      const status = req.query.status || 'pending';
      if (status !== 'all' && !HAZARD_REPORT_STATUSES.includes(status)) {
        return res.status(400).json({ ok: false, error: `status must be all or one of: ${HAZARD_REPORT_STATUSES.join(', ')}` });
      }
      return res.json({ ok: true, reports: reports.list(status) });
    },

    async approve(req, res) {
      try { res.json({ ok: true, report: await reports.approve(req.params.id) }); } catch (err) { sendError(res, err); }
    },

    async reject(req, res) {
      try { res.json({ ok: true, report: await reports.reject(req.params.id) }); } catch (err) { sendError(res, err); }
    },

    async remove(req, res) {
      try { await reports.remove(req.params.id); res.json({ ok: true }); } catch (err) { sendError(res, err); }
    },
  };
}

module.exports = { createHazardController, createRateLimiter, parseBBox };
