const { Schema, model } = require('mongoose');
const {
  REPORT_TYPES, REPORT_STATUSES, REPORT_VOTES, LIMITS,
} = require('./navigationConstants');

/**
 * One community road report from the mobile app (accident, traffic jam,
 * closure, construction, hazard). Unverified until a moderator says
 * otherwise. Written through services/navigation/roadReportService.js.
 *
 * Lifetime: a report is visible while status = "active" and expiresAt is in
 * the future. Each confirmation extends expiresAt (up to a cap); enough
 * dismissals hide it ("dismissed"); its reporter can withdraw it and a
 * moderator can remove or resolve it. An active report past expiresAt is
 * shown as "expired" - that status is computed, never stored.
 *
 * Privacy: `reporterId` and `votes[].deviceId` are pseudonymous device ids
 * (utils/deviceToken.js). They are never returned by the API. `purgeAt`
 * carries a TTL index: MongoDB deletes the document then
 * (REPORT_RETENTION_DAYS after it stopped being active; null = kept).
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

const voteSchema = new Schema({
  deviceId: { type: String, required: true },
  vote: { type: String, enum: REPORT_VOTES, required: true },
  at: { type: Date, required: true },
}, { _id: false });

const roadReportSchema = new Schema({
  type: { type: String, enum: REPORT_TYPES, required: true },
  location: { type: pointSchema, required: true },
  // Reporter's direction of travel (degrees), to tell the two sides of a road apart.
  heading: { type: Number, default: null, min: 0, max: 359.9 },
  description: { type: String, default: null, maxlength: LIMITS.reportDescriptionLength },
  reporterId: { type: String, required: true },
  platform: { type: String, default: null },
  status: { type: String, enum: REPORT_STATUSES, required: true, default: 'active' },
  verification: { type: String, enum: ['verified', 'unverified'], required: true, default: 'unverified' },
  confirmations: { type: Number, required: true, default: 0, min: 0 },
  dismissals: { type: Number, required: true, default: 0, min: 0 },
  votes: { type: [voteSchema], default: [] }, // capped at MAX_STORED_VOTES, newest kept
  expiresAt: { type: Date, required: true },
  purgeAt: { type: Date, default: null },
}, {
  collection: 'roadReports',
  versionKey: false,
  timestamps: true, // createdAt, updatedAt
});

// Map-area and near-route queries for visible reports.
roadReportSchema.index({ location: '2dsphere', status: 1, expiresAt: 1 });
// Per-device checks (active report cap).
roadReportSchema.index({ reporterId: 1, status: 1, expiresAt: 1 });
// Retention: MongoDB deletes the document at purgeAt.
roadReportSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('RoadReport', roadReportSchema);
