const defaultRoadFeature = require('../../models/RoadFeature');
const { isDatabaseConnected } = require('../../config/database');
const { bboxQueryPolygon, bboxContainsPoint } = require('../../utils/geo');
const { ApiError, dbUnavailable, notFound } = require('../../utils/apiError');
const { LIMITS } = require('../../models/navigationConstants');

/**
 * Operator-managed road features in MongoDB (models/RoadFeature.js).
 * Public reads return only features in force now (active, inside their
 * validity window); the admin endpoints manage all of them.
 *
 * Public feature (same shape as OpenStreetMap features from
 * overpassService.js, so the app handles one list):
 *   { id, kind, lat, lng, name, description, direction, speedLimitKmh,
 *     source, provider: 'smarttraffic', verification: 'verified',
 *     active, validFrom, validUntil, url: null, updatedAt }
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);

function toPublic(doc) {
  return {
    id: String(doc._id),
    kind: doc.kind,
    lat: doc.location.coordinates[1],
    lng: doc.location.coordinates[0],
    name: doc.name || null,
    description: doc.description || null,
    direction: doc.direction ?? null,
    speedLimitKmh: doc.speedLimitKmh ?? null,
    source: doc.source || 'SmartTraffic operator',
    provider: 'smarttraffic',
    verification: 'verified',
    active: doc.active,
    validFrom: iso(doc.validFrom),
    validUntil: iso(doc.validUntil),
    url: null,
    updatedAt: iso(doc.updatedAt),
  };
}

function createRoadFeatureService({ RoadFeature = defaultRoadFeature, isConnected = isDatabaseConnected, now = Date.now } = {}) {
  const Model = RoadFeature;
  const requireDb = () => { if (!isConnected()) throw dbUnavailable(); };

  /** Features shown to the app right now. */
  const inForce = (t) => ({
    active: true,
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: t } }] },
      { $or: [{ validUntil: null }, { validUntil: { $gt: t } }] },
    ],
  });

  async function load(id) {
    const doc = await Model.findById(id).lean();
    if (!doc) throw notFound(`No road feature "${id}"`);
    return doc;
  }

  return {
    available: () => isConnected(),

    /** In-force features inside bbox. Resolves { features, truncated }. */
    async findInBBox(bbox, { kinds, limit = LIMITS.maxListResults } = {}) {
      requireDb();
      const filter = { ...inForce(new Date(now())), location: { $geoWithin: { $geometry: bboxQueryPolygon(bbox) } } };
      if (kinds) filter.kind = { $in: kinds };
      const docs = await Model.find(filter).limit(limit + 1).lean();
      const inside = docs.map(toPublic).filter((f) => bboxContainsPoint(bbox, f));
      return { features: inside.slice(0, limit), truncated: docs.length > limit };
    },

    async get(id) {
      requireDb();
      return toPublic(await load(id));
    },

    async create(input) {
      requireDb();
      const doc = await Model.create(input);
      return toPublic(doc.toObject());
    },

    async update(id, changes) {
      requireDb();
      const doc = await Model.findById(id);
      if (!doc) throw notFound(`No road feature "${id}"`);
      doc.set(changes);
      if (doc.validFrom && doc.validUntil && doc.validFrom >= doc.validUntil) {
        throw new ApiError(400, 'INVALID_REQUEST', 'validFrom must be before validUntil');
      }
      await doc.save();
      return toPublic(doc.toObject());
    },

    async remove(id) {
      requireDb();
      const doc = await Model.findByIdAndDelete(id).lean();
      if (!doc) throw notFound(`No road feature "${id}"`);
      return toPublic(doc);
    },
  };
}

module.exports = { createRoadFeatureService, toPublicFeature: toPublic };
