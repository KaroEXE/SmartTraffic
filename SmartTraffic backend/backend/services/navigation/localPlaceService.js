const defaultLocalPlace = require('../../models/LocalPlace');
const { isDatabaseConnected } = require('../../config/database');
const { bboxQueryPolygon, bboxContainsPoint } = require('../../utils/geo');
const { dbUnavailable, notFound } = require('../../utils/apiError');
const { LIMITS } = require('../../models/navigationConstants');

/**
 * Hawr's own important places (models/LocalPlace.js), managed by the operator.
 *
 * Public place:
 *   { id, name, nameAr, nameKu, category, lat, lng, description, active, updatedAt }
 * In a search answer the same record is a Place (id "hawr:<id>", source "hawr").
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);
const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function toPublic(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    nameAr: doc.nameAr || null,
    nameKu: doc.nameKu || null,
    category: doc.category,
    lat: doc.location.coordinates[1],
    lng: doc.location.coordinates[0],
    description: doc.description || null,
    active: doc.active,
    updatedAt: iso(doc.updatedAt),
  };
}

/** A local place as a search result: the name in the reader's language when the operator entered one. */
function toSearchPlace(doc, lang) {
  const name = (lang === 'ar' && doc.nameAr) || (lang === 'ku' && doc.nameKu) || doc.name;
  return {
    id: `hawr:${doc._id}`,
    name,
    address: doc.description || null,
    lat: doc.location.coordinates[1],
    lng: doc.location.coordinates[0],
    category: doc.category,
    type: 'local',
    source: 'hawr',
    boundingBox: null,
    addressDetails: null,
  };
}

function createLocalPlaceService({ LocalPlace = defaultLocalPlace, isConnected = isDatabaseConnected } = {}) {
  const requireDb = () => { if (!isConnected()) throw dbUnavailable(); };

  async function load(id) {
    const doc = await LocalPlace.findById(id).lean();
    if (!doc) throw notFound(`No local place "${id}"`);
    return doc;
  }

  return {
    available: () => isConnected(),

    /** Active places inside bbox, optionally of some categories. Resolves { places, truncated }. */
    async findInBBox(bbox, { categories, limit = LIMITS.maxListResults } = {}) {
      requireDb();
      const filter = { active: true, location: { $geoWithin: { $geometry: bboxQueryPolygon(bbox) } } };
      if (categories) filter.category = { $in: categories };
      const docs = await LocalPlace.find(filter).limit(limit + 1).lean();
      const inside = docs.map(toPublic).filter((p) => bboxContainsPoint(bbox, p));
      return { places: inside.slice(0, limit), truncated: docs.length > limit };
    },

    /** Search results for placeService: active places whose name (in any language) contains q. Never throws without a database. */
    async search({ q, limit = 5, lang = null }) {
      if (!isConnected()) return [];
      const pattern = new RegExp(escapeRegExp(q), 'i');
      const docs = await LocalPlace.find({ active: true, $or: [{ name: pattern }, { nameAr: pattern }, { nameKu: pattern }] }).limit(limit).lean();
      return docs.map((d) => toSearchPlace(d, lang));
    },

    /** Operator listing, active or not, newest first. Resolves { places, total, page, limit }. */
    async list({ category, active, page = 1, limit = 25 } = {}) {
      requireDb();
      const filter = {};
      if (category) filter.category = category;
      if (active !== undefined) filter.active = active;
      const [docs, total] = await Promise.all([
        LocalPlace.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        LocalPlace.countDocuments(filter),
      ]);
      return {
        places: docs.map(toPublic), total, page, limit,
      };
    },

    /** Operator statistics: { total, active, byCategory }. */
    async counts() {
      requireDb();
      const rows = await LocalPlace.aggregate([{ $group: { _id: { category: '$category', active: '$active' }, n: { $sum: 1 } } }]);
      const byCategory = {};
      let total = 0;
      let active = 0;
      for (const r of rows) {
        byCategory[r._id.category] = (byCategory[r._id.category] || 0) + r.n;
        total += r.n;
        if (r._id.active) active += r.n;
      }
      return { total, active, byCategory };
    },

    async get(id) {
      requireDb();
      return toPublic(await load(id));
    },

    async create(input) {
      requireDb();
      const doc = await LocalPlace.create(input);
      return toPublic(doc.toObject());
    },

    async update(id, changes) {
      requireDb();
      const doc = await LocalPlace.findById(id);
      if (!doc) throw notFound(`No local place "${id}"`);
      doc.set(changes);
      await doc.save();
      return toPublic(doc.toObject());
    },

    async remove(id) {
      requireDb();
      const doc = await LocalPlace.findByIdAndDelete(id).lean();
      if (!doc) throw notFound(`No local place "${id}"`);
      return toPublic(doc);
    },
  };
}

module.exports = { createLocalPlaceService, toPublicLocalPlace: toPublic };
