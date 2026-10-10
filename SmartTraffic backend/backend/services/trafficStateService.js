const EventEmitter = require('events');

/**
 * Traffic State Service - latest validated perception observation per
 * intersection.
 *
 * Stores observations only. It makes no traffic decisions and does not
 * depend on the decision engine. It never creates data on its own; every
 * state comes from an accepted POST /api/traffic.
 *
 * Other backend services can read it:
 *   const { trafficStateService } = require('./services/trafficStateService');
 *   trafficStateService.getTrafficState('main');
 *   trafficStateService.on('stateUpdated', (state) => { ... });
 *
 * Stored state:
 *   {
 *     intersectionId, timestamp,        // timestamp = producer's capture time (ISO) or null
 *     receivedAt,                       // server receive time (ISO)
 *     sequence,                         // accepted updates for this intersection
 *     source,                           // optional producer tag, e.g. "python-ai"
 *     traffic: { north: { vehicles, queueLength, waitingTime, classes, confidence } | null, south, east, west },
 *                                       // null = the producer has no source for that approach
 *     pedestrians: { north, south, east, west },   // booleans
 *     emergency: { detected, type, direction, confidence },
 *     detectors: { pedestrians, emergency }        // which detectors reported
 *   }
 */

// Out-of-order protection only applies while the stored observation is this recent.
const RECENT_WINDOW_MS = 10_000;
// Hard cap on stored intersections (input is validated upstream; this is a backstop).
const MAX_INTERSECTIONS = 500;

const clone = (value) => structuredClone(value);

class TrafficStateService extends EventEmitter {
  constructor({ now = Date.now, maxIntersections = MAX_INTERSECTIONS } = {}) {
    super();
    this.now = now;
    this.maxIntersections = maxIntersections;
    this.states = new Map();
  }

  /**
   * Stores a validated observation as the latest state of its intersection.
   * Returns { stored: true, state } or { stored: false, reason, state } where
   * reason is 'stale' (older than the stored observation) or 'capacity'.
   */
  setTrafficState(observation) {
    const id = observation.intersectionId;
    const now = this.now();
    const current = this.states.get(id);

    if (!current && this.states.size >= this.maxIntersections) {
      return { stored: false, reason: 'capacity', state: null };
    }

    if (current) {
      const recentlyUpdated = now - current._receivedMs <= RECENT_WINDOW_MS;

      // HTTP requests can arrive out of order; keep the newest capture.
      // (Only while the stored one is recent, so a producer clock reset
      // cannot block an intersection forever.)
      if (observation.timestamp && current.timestamp && recentlyUpdated
        && Date.parse(observation.timestamp) < Date.parse(current.timestamp)) {
        return { stored: false, reason: 'stale', state: this.getTrafficState(id) };
      }
    }

    const state = {
      intersectionId: id,
      timestamp: observation.timestamp,
      receivedAt: new Date(now).toISOString(),
      sequence: current ? current.sequence + 1 : 1,
      source: observation.source || null,
      traffic: clone(observation.traffic),
      pedestrians: clone(observation.pedestrians),
      emergency: clone(observation.emergency),
      detectors: clone(observation.detectors || { pedestrians: false, emergency: false }),
    };
    // Replaces the previous entry: one state per intersection, never duplicates.
    this.states.set(id, { ...state, _receivedMs: now });

    const copy = clone(state);
    this.emit('stateUpdated', copy);
    return { stored: true, state: clone(state) };
  }

  /** Latest state for one intersection (a copy), or null if nothing received yet. */
  getTrafficState(intersectionId) {
    const s = this.states.get(intersectionId);
    if (!s) return null;
    const { _receivedMs, ...state } = s;
    return clone(state);
  }

  /** Latest state of every intersection that has reported (copies). */
  getAllTrafficStates() {
    return [...this.states.keys()].map((id) => this.getTrafficState(id));
  }

  hasTrafficState(intersectionId) {
    return this.states.has(intersectionId);
  }

  /** Seconds since the last accepted update for an intersection, or null. */
  getAgeSeconds(intersectionId) {
    const s = this.states.get(intersectionId);
    return s ? Math.round((this.now() - s._receivedMs) / 100) / 10 : null;
  }

  clear(intersectionId) {
    if (intersectionId === undefined) this.states.clear();
    else this.states.delete(intersectionId);
  }
}

function createTrafficStateService(options) {
  return new TrafficStateService(options);
}

// Shared instance: the ingestion controller writes to it, other backend
// services read from it (Node's module cache makes this a singleton).
const trafficStateService = createTrafficStateService();

module.exports = { TrafficStateService, createTrafficStateService, trafficStateService };
