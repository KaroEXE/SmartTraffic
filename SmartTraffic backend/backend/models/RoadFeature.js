const { Schema, model } = require('mongoose');
const { FEATURE_KINDS, LIMITS } = require('./navigationConstants');

/**
 * One operator-managed road feature: a speed camera, speed bump, road
 * closure or roadworks site. Written only through the admin endpoints of
 * the navigation API (NAV_ADMIN_TOKEN), so every record counts as verified.
 * The app reads them with GET /api/v1/road-features, merged with the
 * community-mapped OpenStreetMap features.
 *
 * `location` is a GeoJSON Point ([lng, lat]) with a 2dsphere index, queried
 * by map area ($geoWithin) and near routes. Closures and roadworks may be
 * limited in time with validFrom / validUntil; outside that window, or with
 * active=false, a feature is not shown to the app.
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

const roadFeatureSchema = new Schema({
  kind: { type: String, enum: FEATURE_KINDS, required: true },
  location: { type: pointSchema, required: true },
  name: { type: String, default: null, maxlength: LIMITS.nameLength },
  description: { type: String, default: null, maxlength: LIMITS.descriptionLength },
  // Compass bearing (degrees) the feature applies to, e.g. a camera's direction; null = both ways / unknown.
  direction: { type: Number, default: null, min: 0, max: 359.9 },
  speedLimitKmh: { type: Number, default: null, min: 5, max: 200 },
  // Who reported it to the operator, e.g. "City traffic department".
  source: { type: String, default: null, maxlength: LIMITS.sourceLength },
  active: { type: Boolean, required: true, default: true },
  validFrom: { type: Date, default: null },
  validUntil: { type: Date, default: null },
}, {
  collection: 'roadFeatures',
  versionKey: false,
  timestamps: true, // createdAt, updatedAt
});

// Map-area queries: features of some kinds inside a box.
roadFeatureSchema.index({ location: '2dsphere', kind: 1, active: 1 });

module.exports = model('RoadFeature', roadFeatureSchema);
