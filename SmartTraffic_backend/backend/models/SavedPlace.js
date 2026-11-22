const { Schema, model } = require('mongoose');
const { SAVED_PLACE_KINDS, LIMITS } = require('./navigationConstants');

/**
 * A place a signed-in user saved (home, work, a favourite). Belongs to one user
 * (`userId`) and is only ever read or changed with that user's token. Deleted
 * with the account.
 */
const savedPlaceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  label: { type: String, required: true, trim: true, maxlength: LIMITS.savedLabelLength },
  kind: { type: String, enum: SAVED_PLACE_KINDS, required: true, default: 'favorite' },
  address: { type: String, default: null, trim: true, maxlength: LIMITS.addressLength },
  location: {
    type: {
      type: String, enum: ['Point'], required: true,
    },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) => c.length === 2 && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90,
        message: 'coordinates must be [lng, lat]',
      },
    },
  },
}, {
  collection: 'savedPlaces',
  versionKey: false,
  timestamps: true,
});

savedPlaceSchema.index({ userId: 1, createdAt: -1 });

module.exports = model('SavedPlace', savedPlaceSchema);
