const defaultTrafficRecord = require('../models/TrafficRecord');
const defaultSignalEvent = require('../models/SignalEvent');
const { isDatabaseConnected } = require('../config/database');
const { DIRECTIONS, DATA_MODES, modeFilter } = require('../models/constants');

/**
 * Traffic History - writes historical data to MongoDB. Read-only towards the
 * rest of the backend: it only listens to events that already exist.
 *
 *   trafficStateService 'stateUpdated'  -> TrafficRecord  (every accepted observation)
 *   decisionService     'signalUpdate'  -> SignalEvent    (every phase change)
 *
 * One instance per data channel: `dataMode` ('live' or 'simulation') is
 * stamped on everything the instance writes. It comes from server wiring,
 * never from a request. Reads go through findTrafficRecords() /
 * findSignalEvents(), which always apply the mode filter.
 *
 * Writes never block or fail ingestion or signal control. When the database
 * is unavailable, records are counted as not saved and a warning is logged
 * (at most once a minute per problem).
 */

const WARN_INTERVAL_MS = 60_000;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;

const round1 = (n) => Math.round(n * 10) / 10;

function signalChanges(prev, snap) {
  const changes = [];
  for (const direction of DIRECTIONS) {
    if (prev.signals[direction] !== snap.signals[direction]) {
      changes.push({ direction, kind: 'vehicle', from: prev.signals[direction], to: snap.signals[direction] });
    }
    if (prev.pedestrianSignals[direction] !== snap.pedestrianSignals[direction]) {
      changes.push({
        direction, kind: 'pedestrian', from: prev.pedestrianSignals[direction], to: snap.pedestrianSignals[direction],
      });
    }
  }
  return changes;
}

class TrafficHistoryService {
  constructor({
    stateService,
    decisionService,
    TrafficRecord = defaultTrafficRecord,
    SignalEvent = defaultSignalEvent,
    isConnected = isDatabaseConnected,
    log = console,
    dataMode = 'live',
  }) {
    if (!DATA_MODES.includes(dataMode)) throw new RangeError(`Unknown data mode "${dataMode}"`);
    this.dataMode = dataMode;
    this.stateService = stateService;
    this.decisionService = decisionService;
    this.TrafficRecord = TrafficRecord;
    this.SignalEvent = SignalEvent;
    this.isConnected = isConnected;
    this.log = log;

    this.lastPhase = new Map(); // intersectionId -> { phase, signals, pedestrianSignals, startedAt }
    this.lastCaptureTime = new Map(); // intersectionId -> producer timestamp of the last record
    this.warnings = new Map(); // key -> { at, suppressed }
    this.counts = { trafficRecordsSaved: 0, signalEventsSaved: 0, notSaved: 0 };
    this.pending = new Set();

    this.onState = (state) => this.recordObservation(state);
    this.onSignal = (snap) => this.recordSignal(snap);
  }

  start() {
    this.stateService.on('stateUpdated', this.onState);
    this.decisionService.on('signalUpdate', this.onSignal);
    return this;
  }

  stop() {
    this.stateService.off('stateUpdated', this.onState);
    this.decisionService.off('signalUpdate', this.onSignal);
  }

  stats() {
    return { ...this.counts };
  }

  /** Forget per-intersection tracking (used when a simulation is reset, so a new run is not compared with the old one). */
  resetTracking() {
    this.lastPhase.clear();
    this.lastCaptureTime.clear();
  }

  // ----------------------------------------------------------------- queries

  /** Newest-first traffic observations of ONE mode (default live). */
  findTrafficRecords(options) {
    return this._find(this.TrafficRecord, options);
  }

  /** Newest-first signal phase changes of ONE mode (default live). */
  findSignalEvents(options) {
    return this._find(this.SignalEvent, options);
  }

  async _find(Model, { mode = 'live', intersectionId, from, to, limit } = {}) {
    // modeFilter() throws for anything but 'live' / 'simulation'.
    const filter = { ...modeFilter(mode) };
    if (intersectionId !== undefined) {
      if (typeof intersectionId !== 'string') throw new TypeError('intersectionId must be a string');
      filter.intersectionId = intersectionId;
    }
    const range = {};
    if (from !== undefined) range.$gte = new Date(from);
    if (to !== undefined) range.$lte = new Date(to);
    if ((range.$gte && Number.isNaN(range.$gte.getTime())) || (range.$lte && Number.isNaN(range.$lte.getTime()))) {
      throw new TypeError('from / to must be valid dates');
    }
    if (range.$gte || range.$lte) filter.timestamp = range;

    const n = Math.min(MAX_QUERY_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_QUERY_LIMIT));
    if (!this.isConnected()) {
      throw Object.assign(new Error('Database not connected'), { code: 'DB_UNAVAILABLE' });
    }
    return Model.find(filter).sort({ timestamp: -1 }).limit(n).lean();
  }

  /** Resolves when every write started so far has finished (used on shutdown and in tests). */
  async flush() {
    await Promise.allSettled([...this.pending]);
  }

  // ------------------------------------------------------------- recording

  recordObservation(state) {
    // The same capture posted twice (e.g. an HTTP retry) is one observation.
    if (state.timestamp && this.lastCaptureTime.get(state.intersectionId) === state.timestamp) return null;
    if (state.timestamp) this.lastCaptureTime.set(state.intersectionId, state.timestamp);

    const snap = this.decisionService.getSnapshot(state.intersectionId);
    if (!snap) return null;
    return this._save(this.TrafficRecord, 'trafficRecordsSaved', 'Traffic record', {
      dataMode: this.dataMode,
      intersectionId: state.intersectionId,
      timestamp: new Date(state.timestamp || state.receivedAt),
      receivedAt: new Date(state.receivedAt),
      source: state.source,
      traffic: state.traffic,
      pedestrians: state.pedestrians,
      emergency: state.emergency,
      signal: {
        mode: snap.mode,
        phase: snap.phase,
        signals: snap.signals,
        pedestrianSignals: snap.pedestrianSignals,
      },
    });
  }

  recordSignal(snap) {
    const id = snap.intersectionId;
    const prev = this.lastPhase.get(id);
    const changes = prev ? signalChanges(prev, snap) : [];
    // Plan/reason/mode update within the same phase: keep that phase's start time.
    if (prev && snap.phase === prev.phase && changes.length === 0) return null;

    const startedAt = Date.parse(snap.serverTime) - snap.elapsed * 1000;
    this.lastPhase.set(id, {
      phase: snap.phase, signals: snap.signals, pedestrianSignals: snap.pedestrianSignals, startedAt,
    });
    if (!prev) return null; // first state seen since startup: nothing to compare with

    // Only data-driven control is recorded; fixed-time cycling with no
    // perception feed carries no traffic information and would never stop.
    if (snap.aiStatus !== 'CONNECTED') return null;

    return this._save(this.SignalEvent, 'signalEventsSaved', 'Signal event', {
      dataMode: this.dataMode,
      intersectionId: id,
      timestamp: new Date(startedAt),
      mode: snap.mode,
      phase: snap.phase,
      previousPhase: prev.phase,
      signals: snap.signals,
      pedestrianSignals: snap.pedestrianSignals,
      changes,
      reason: snap.reason,
      plannedDuration: snap.phaseDuration,
      previousPhaseDuration: Math.max(0, round1((startedAt - prev.startedAt) / 1000)),
    });
  }

  // ----------------------------------------------------------------- writes

  _save(Model, counter, label, doc) {
    if (!this.isConnected()) {
      this.counts.notSaved += 1;
      this._warn('offline', 'Database not connected - traffic history is not being saved');
      return null;
    }
    const write = Model.create(doc).then(
      () => { this.counts[counter] += 1; },
      (err) => {
        this.counts.notSaved += 1;
        if (err && err.name === 'ValidationError') {
          this._warn(`invalid:${label}`, `Invalid ${label.toLowerCase()} - not saved: ${err.message}`);
        } else {
          this._warn(`failed:${label}`, `${label} could not be saved: ${err && err.message}`);
        }
      },
    ).finally(() => this.pending.delete(write));
    this.pending.add(write);
    return write;
  }

  _warn(key, message) {
    const now = Date.now();
    const w = this.warnings.get(key);
    if (w && now - w.at < WARN_INTERVAL_MS) {
      w.suppressed += 1;
      return;
    }
    const extra = w && w.suppressed ? ` (${w.suppressed} more since last report)` : '';
    this.warnings.set(key, { at: now, suppressed: 0 });
    this.log.warn(`[history] ${message}${extra}`);
  }
}

function createTrafficHistoryService(options) {
  return new TrafficHistoryService(options);
}

module.exports = { TrafficHistoryService, createTrafficHistoryService };
