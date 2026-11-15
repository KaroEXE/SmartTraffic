const { Schema, model } = require('mongoose');
const { LOCAL_PLACE_CATEGORIES, LIMITS } = require('./navigationConstants');

/**
 * One of Hawr's own important places (a hospital, a mosque, a landmark ...): data the
 * base map or the search provider does not have or gets wrong. Entered by the operator in
 * the admin console, shown as a map layer, and searched before the search provider.
 *
 * Names: `name` is the main name; `nameAr` and `nameKu` (Sorani) are used when a reader
 * asks for that language. `location` is a GeoJSON Point ([lng, lat]) with a 2dsphere index.
 */
const pointSchema = new Schema({
  type: { type: String, enum: ['Point'], required: true },
  coordinates: {
    type: [Number],
    required: true,
    validate: {
      validator: (c) => c.length === 2 && c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90,
      message: 'coordinates must be [lng, lat]',
    },
  },
}, { _id: false });

const localPlaceSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: LIMITS.nameLength },
  nameAr: { type: String, default: null, trim: true, maxlength: LIMITS.nameLength },
  nameKu: { type: String, default: null, trim: true, maxlength: LIMITS.nameLength },
  category: { type: String, enum: LOCAL_PLACE_CATEGORIES, required: true },
  location: { type: pointSchema, required: true },
  description: { type: String, default: null, maxlength: LIMITS.descriptionLength },
  active: { type: Boolean, required: true, default: true },
}, {
  collection: 'localPlaces',
  versionKey: false,
  timestamps: true,
});

localPlaceSchema.index({ location: '2dsphere', category: 1, active: 1 });

module.exports = model('LocalPlace', localPlaceSchema);
