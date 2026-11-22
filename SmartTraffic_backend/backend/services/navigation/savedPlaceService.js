const defaultSavedPlace = require('../../models/SavedPlace');
const { isDatabaseConnected } = require('../../config/database');
const { ApiError, dbUnavailable, notFound } = require('../../utils/apiError');
const { LIMITS } = require('../../models/navigationConstants');

/**
 * A signed-in user's saved places (models/SavedPlace.js). Every query is scoped to the
 * user id from the verified token: one user can never read or change another's places.
 *
 * Saved place: { id, label, kind, address, lat, lng, createdAt, updatedAt }
 */

const iso = (d) => (d ? new Date(d).toISOString() : null);

function toPublic(doc) {
  return {
    id: String(doc._id),
    label: doc.label,
    kind: doc.kind,
    address: doc.address || null,
    lat: doc.location.coordinates[1],
    lng: doc.location.coordinates[0],
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

function createSavedPlaceService({ SavedPlace = defaultSavedPlace, isConnected = isDatabaseConnected } = {}) {
  const requireDb = () => { if (!isConnected()) throw dbUnavailable(); };

  return {
    async list(userId) {
      requireDb();
      const docs = await SavedPlace.find({ userId }).sort({ createdAt: -1 }).limit(LIMITS.maxSavedPlaces).lean();
      return docs.map(toPublic);
    },

    async create(userId, input) {
      requireDb();
      if (await SavedPlace.countDocuments({ userId }) >= LIMITS.maxSavedPlaces) {
        throw new ApiError(409, 'SAVED_PLACE_LIMIT', `At most ${LIMITS.maxSavedPlaces} places can be saved: delete one first`);
      }
      const doc = await SavedPlace.create({ ...input, userId });
      return toPublic(doc.toObject());
    },

    async update(userId, id, changes) {
      requireDb();
      const doc = await SavedPlace.findOne({ _id: id, userId });
      if (!doc) throw notFound(`No saved place "${id}"`);
      doc.set(changes);
      await doc.save();
      return toPublic(doc.toObject());
    },

    async remove(userId, id) {
      requireDb();
      const doc = await SavedPlace.findOneAndDelete({ _id: id, userId }).lean();
      if (!doc) throw notFound(`No saved place "${id}"`);
      return toPublic(doc);
    },

    /** Called when an account is deleted. */
    async removeAllFor(userId) {
      await SavedPlace.deleteMany({ userId });
    },
  };
}

module.exports = { createSavedPlaceService };
