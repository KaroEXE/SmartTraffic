const { Schema, model } = require('mongoose');
const {
  DIRECTIONS, MODES, PHASES, VEHICLE_SIGNALS, PEDESTRIAN_SIGNALS, DATA_MODES, perDirection,
} = require('./constants');

/**
 * One signal phase change decided by the decision engine, e.g.
 * GREEN -> YELLOW. Append-only history.
 *
 * `plannedDuration` is the engine's plan for the new phase when it began;
 * `previousPhaseDuration` is how long the phase that just ended actually
 * lasted. Together they give planned-vs-actual pairs for every phase.
 */

const change = new Schema({
  direction: { type: String, enum: DIRECTIONS, required: true },
  kind: { type: String, enum: ['vehicle', 'pedestrian'], required: true },
  from: { type: String, enum: [...VEHICLE_SIGNALS, ...PEDESTRIAN_SIGNALS], required: true },
  to: { type: String, enum: [...VEHICLE_SIGNALS, ...PEDESTRIAN_SIGNALS], required: true },
}, { _id: false });

const signalEventSchema = new Schema({
  intersectionId: { type: String, required: true, match: /^[A-Za-z0-9_-]{1,64}$/ },
  // 'live' or 'simulation'; set by the server. Query through modeFilter().
  dataMode: { type: String, enum: DATA_MODES, default: 'live', required: true },
  timestamp: { type: Date, required: true }, // when the new phase began
  mode: { type: String, enum: MODES, required: true },
  phase: { type: String, enum: PHASES, required: true },
  previousPhase: { type: String, enum: PHASES, required: true },
  signals: perDirection(() => ({ type: String, enum: VEHICLE_SIGNALS, required: true })),
  pedestrianSignals: perDirection(() => ({ type: String, enum: PEDESTRIAN_SIGNALS, required: true })),
  changes: { type: [change], required: true },
  reason: { type: String, required: true }, // the engine's own explanation, verbatim
  plannedDuration: { type: Number, required: true, min: 0 }, // seconds
  previousPhaseDuration: { type: Number, required: true, min: 0 }, // seconds, measured
}, {
  collection: 'signalEvents',
  versionKey: false,
});

// One intersection's signal history over a time range.
signalEventSchema.index({ intersectionId: 1, timestamp: 1 });

module.exports = model('SignalEvent', signalEventSchema);
