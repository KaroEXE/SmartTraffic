const { Schema, model } = require('mongoose');
const { DIRECTIONS } = require('./constants');
const {
  SOURCE_TYPES, STREAM_STATUSES, MAX_URL_LENGTH, MAX_NAME_LENGTH, MAX_PRIORITY, MAX_ERROR_LENGTH,
} = require('../utils/streamValidation');

/**
 * One configured camera stream (e.g. a YouTube Live URL) and which approach
 * of which intersection it may feed. Written through the stream API
 * (services/streamRegistryService.js); the Python AI service reads the
 * enabled ones with GET /api/streams and reports their health back.
 *
 * `_id` is the stream id ("main-north-1"): stable, chosen by whoever
 * registers the stream, and used by the AI service in its reports.
 *
 * Configuration fields: name, url, sourceType, intersectionId, direction,
 * enabled, priority (lower = tried first among streams of the same slot).
 * Health fields (written only from AI health reports): status, active,
 * lastHealthCheckAt, lastFrameAt, lastInferenceAt, consecutiveFailures,
 * lastError (sanitized: no URLs or credentials).
 */

const trafficStreamSchema = new Schema({
  _id: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,64}$/ },
  name: { type: String, required: true, trim: true, maxlength: MAX_NAME_LENGTH },
  // May carry private tokens: only returned to authenticated callers, never logged.
  url: { type: String, required: true, trim: true, maxlength: MAX_URL_LENGTH },
  sourceType: { type: String, enum: SOURCE_TYPES, required: true },
  intersectionId: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,64}$/ },
  // null = covers the whole intersection (not tied to one approach).
  direction: { type: String, enum: [...DIRECTIONS, null], default: null },
  enabled: { type: Boolean, required: true, default: true },
  priority: {
    type: Number, required: true, default: 0, min: 0, max: MAX_PRIORITY, validate: Number.isInteger,
  },

  status: { type: String, enum: STREAM_STATUSES, required: true, default: 'unknown' },
  active: { type: Boolean, required: true, default: false },
  lastHealthCheckAt: { type: Date, default: null },
  lastFrameAt: { type: Date, default: null },
  lastInferenceAt: { type: Date, default: null },
  consecutiveFailures: { type: Number, default: 0, min: 0 },
  lastError: { type: String, default: null, maxlength: MAX_ERROR_LENGTH },
}, {
  collection: 'trafficStreams',
  versionKey: false,
  timestamps: true, // createdAt, updatedAt
});

// The AI service's query: enabled streams of one intersection, best first.
trafficStreamSchema.index({ intersectionId: 1, direction: 1, enabled: 1, priority: 1 });
// The same URL registered twice for the same slot is almost certainly a mistake.
trafficStreamSchema.index({ url: 1, intersectionId: 1, direction: 1 }, { unique: true });

module.exports = model('TrafficStream', trafficStreamSchema);
