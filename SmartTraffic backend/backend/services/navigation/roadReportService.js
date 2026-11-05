const defaultRoadReport = require('../../models/RoadReport');
const { isDatabaseConnected } = require('../../config/database');
const { bboxQueryPolygon, bboxContainsPoint } = require('../../utils/geo');
const { ApiError, dbUnavailable, notFound } = require('../../utils/apiError');
const { LIMITS, MAX_STORED_VOTES } = require('../../models/navigationConstants');

/**
 * Community road reports in MongoDB (models/RoadReport.js).
 *
 *   create   a device reports something. If an active report of the same
 *            type exists within REPORT_MERGE_RADIUS_METERS, the new report
 *            confirms that one instead (no duplicate pins on the map).
 *   vote     another device confirms ("still there") or dismisses ("not
 *            there"). One vote per device per report, never on its own.
 *            A confirmation extends the report's life; enough dismissals
 *            (REPORT_DISMISS_THRESHOLD, outnumbering confirmations) hide it.
 *   withdraw the reporting device takes its report back.
 *   moderate the operator (NAV_ADMIN_TOKEN) removes, resolves, reactivates
 *            or verifies a report.
 *
 * Public report (device ids are never returned):
 *   { id, type, lat, lng, heading, description,
 *     status: 'active' | 'expired' | 'withdrawn' | 'removed' | 'resolved' | 'dismissed',
 *     verification: 'unverified' | 'verified', confirmations, dismissals,
 *     createdAt, updatedAt, expiresAt, mine?, myVote? }
 * `mine` and `myVote` are present when the request carries a device token.
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);
const MINUTE = 60_000;
const DAY = 86_400_000;

const TYPE_LABEL = {
  accident: 'Accident',
  traffic_jam: 'Traffic jam',
  road_closure: 'Road closed',
  construction: 'Construction',
  hazard: 'Hazard on the road',
};

function createRoadReportService({
  RoadReport = defaultRoadReport, isConnected = isDatabaseConnected, config, now = Date.now,
}) {
  const Model = RoadReport;
  const cfg = config;
  const requireDb = () => { if (!isConnected()) throw dbUnavailable(); };
  const ttlMs = (type) => cfg.ttlMinutes[type] * MINUTE;
  const purgeAfter = (date) => (cfg.retentionDays > 0 ? new Date(date.getTime() + cfg.retentionDays * DAY) : null);
  const visible = (t) => ({ status: 'active', expiresAt: { $gt: t } });

  function toPublic(doc, device = null) {
    const t = now();
    const out = {
      id: String(doc._id),
      type: doc.type,
      label: TYPE_LABEL[doc.type] || doc.type,
      lat: doc.location.coordinates[1],
      lng: doc.location.coordinates[0],
      heading: doc.heading ?? null,
      description: doc.description || null,
      status: doc.status === 'active' && new Date(doc.expiresAt).getTime() <= t ? 'expired' : doc.status,
      verification: doc.verification,
      confirmations: doc.confirmations,
      dismissals: doc.dismissals,
      createdAt: iso(doc.createdAt),
      updatedAt: iso(doc.updatedAt),
      expiresAt: iso(doc.expiresAt),
    };
    if (device) {
      out.mine = doc.reporterId === device.id;
      const vote = (doc.votes || []).find((v) => v.deviceId === device.id);
      out.myVote = vote ? vote.vote : null;
    }
    return out;
  }

  async function load(id) {
    const doc = await Model.findById(id).lean();
    if (!doc) throw notFound(`No report "${id}"`);
    return doc;
  }

  /** Records one vote atomically; explains why when it cannot. Returns the updated document. */
  async function applyVote(id, vote, device) {
    const t = new Date(now());
    const field = vote === 'confirm' ? 'confirmations' : 'dismissals';
    let doc = await Model.findOneAndUpdate(
      {
        _id: id, ...visible(t), reporterId: { $ne: device.id }, 'votes.deviceId': { $ne: device.id },
      },
      {
        $push: { votes: { $each: [{ deviceId: device.id, vote, at: t }], $slice: -MAX_STORED_VOTES } },
        $inc: { [field]: 1 },
      },
      { new: true },
    ).lean();
    if (!doc) {
      const current = await load(id);
      if (current.reporterId === device.id) throw new ApiError(403, 'CANNOT_VOTE_OWN_REPORT', 'A device cannot vote on its own report');
      if ((current.votes || []).some((v) => v.deviceId === device.id)) throw new ApiError(409, 'ALREADY_VOTED', 'This device has already voted on this report');
      throw new ApiError(409, 'REPORT_NOT_ACTIVE', 'This report is no longer active');
    }

    if (vote === 'confirm') {
      const cap = new Date(doc.createdAt).getTime() + ttlMs(doc.type) * cfg.maxLifetimeFactor;
      const expiresAt = new Date(Math.min(cap, t.getTime() + ttlMs(doc.type)));
      if (expiresAt > doc.expiresAt) {
        doc = await Model.findOneAndUpdate(
          { _id: id, expiresAt: { $lt: expiresAt } },
          { $set: { expiresAt, purgeAt: purgeAfter(expiresAt) } },
          { new: true },
        ).lean() || await load(id);
      }
    } else if (doc.dismissals >= cfg.dismissThreshold && doc.dismissals > doc.confirmations) {
      doc = await Model.findOneAndUpdate(
        { _id: id, status: 'active' },
        { $set: { status: 'dismissed', purgeAt: purgeAfter(t) } },
        { new: true },
      ).lean() || await load(id);
    }
    return doc;
  }

  return {
    available: () => isConnected(),

    /** Visible reports inside bbox, newest first. Resolves { reports, truncated }. */
    async findInBBox(bbox, { types, limit = LIMITS.maxListResults, device = null } = {}) {
      requireDb();
      const filter = { ...visible(new Date(now())), location: { $geoWithin: { $geometry: bboxQueryPolygon(bbox) } } };
      if (types) filter.type = { $in: types };
      const docs = await Model.find(filter).sort({ createdAt: -1 }).limit(limit + 1).lean();
      const inside = docs.map((d) => toPublic(d, device)).filter((r) => bboxContainsPoint(bbox, r));
      return { reports: inside.slice(0, limit), truncated: docs.length > limit };
    },

    async get(id, device = null) {
      requireDb();
      return toPublic(await load(id), device);
    },

    /** Resolves { report, merged }. merged=true: an existing nearby report was confirmed instead. */
    async create(input, device) {
      requireDb();
      const t = new Date(now());
      const active = await Model.countDocuments({ reporterId: device.id, ...visible(t) });
      if (active >= cfg.maxActivePerDevice) {
        throw new ApiError(429, 'REPORT_LIMIT_REACHED', `This device already has ${active} active reports; wait for them to expire or withdraw one`);
      }
      const location = { type: 'Point', coordinates: [input.lng, input.lat] };

      if (cfg.mergeRadiusMeters > 0) {
        const nearby = await Model.findOne({
          type: input.type,
          ...visible(t),
          location: { $nearSphere: { $geometry: location, $maxDistance: cfg.mergeRadiusMeters } },
        }).lean();
        if (nearby) {
          if (nearby.reporterId === device.id) {
            throw new ApiError(409, 'DUPLICATE_REPORT', 'This device has already reported this here', { extra: { reportId: String(nearby._id) } });
          }
          let doc = nearby;
          if (!(nearby.votes || []).some((v) => v.deviceId === device.id)) {
            doc = await applyVote(nearby._id, 'confirm', device).catch((err) => {
              if (err.code === 'ALREADY_VOTED') return load(nearby._id);
              throw err;
            });
          }
          return { report: toPublic(doc, device), merged: true };
        }
      }

      const expiresAt = new Date(t.getTime() + ttlMs(input.type));
      const doc = await Model.create({
        type: input.type,
        location,
        heading: input.heading,
        description: input.description,
        reporterId: device.id,
        platform: device.platform,
        expiresAt,
        purgeAt: purgeAfter(expiresAt),
      });
      return { report: toPublic(doc.toObject(), device), merged: false };
    },

    async vote(id, vote, device) {
      requireDb();
      return toPublic(await applyVote(id, vote, device), device);
    },

    async withdraw(id, device) {
      requireDb();
      const t = new Date(now());
      const doc = await Model.findOneAndUpdate(
        { _id: id, reporterId: device.id, status: 'active' },
        { $set: { status: 'withdrawn', purgeAt: purgeAfter(t) } },
        { new: true },
      ).lean();
      if (doc) return toPublic(doc, device);
      const current = await load(id);
      if (current.reporterId !== device.id) throw new ApiError(403, 'NOT_REPORT_OWNER', 'Only the device that sent a report can withdraw it');
      throw new ApiError(409, 'REPORT_NOT_ACTIVE', 'This report is no longer active');
    },

    /** Operator: { status?, verification? }. Reactivating an expired report restarts its lifetime. */
    async moderate(id, changes) {
      requireDb();
      const t = new Date(now());
      const doc = await Model.findById(id);
      if (!doc) throw notFound(`No report "${id}"`);
      if (changes.verification) doc.verification = changes.verification;
      if (changes.status && changes.status !== doc.status) {
        doc.status = changes.status;
        if (changes.status === 'active') {
          if (doc.expiresAt <= t) doc.expiresAt = new Date(t.getTime() + ttlMs(doc.type));
          doc.purgeAt = purgeAfter(doc.expiresAt);
        } else {
          doc.purgeAt = purgeAfter(t);
        }
      } else if (changes.status === 'active' && doc.expiresAt <= t) {
        doc.expiresAt = new Date(t.getTime() + ttlMs(doc.type));
        doc.purgeAt = purgeAfter(doc.expiresAt);
      }
      await doc.save();
      return toPublic(doc.toObject());
    },
  };
}

module.exports = { createRoadReportService, REPORT_TYPE_LABEL: TYPE_LABEL };
