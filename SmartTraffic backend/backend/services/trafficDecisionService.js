const EventEmitter = require('events');
const defaultConfig = require('../config');
const { DIRECTIONS } = require('../utils/validation');

/**
 * Traffic Decision Engine
 *
 * One state machine per intersection. The backend is the single source of
 * truth for signal state; clients only render what is emitted from here.
 *
 *   GREEN(dir) -> YELLOW(dir) -> ALL_RED -> GREEN(next) | PED_WALK
 *   PED_WALK -> PED_CLEAR -> GREEN(next)
 *
 * Only one approach is served at a time (protected single-approach phasing),
 * so straight-through movements never conflict. Pedestrians get an
 * exclusive phase with every vehicle approach held at red.
 *
 * Network coordination (services/networkCoordinator.js) can add two inputs:
 *   setNetworkAdvice(id, advice)       network-aware scores per approach and
 *                                      approaches whose exit is blocked; used
 *                                      instead of the local scores in adaptive
 *                                      mode only
 *   setCorridorDirective(id, directive) an emergency corridor asks this
 *                                      intersection to prepare / hold green
 *                                      for one approach
 * Neither bypasses the safety timing: yellow and all-red always run, one
 * approach is green at a time, and minimum green is only cut short when an
 * emergency vehicle is too close to wait (as with camera preemption).
 *
 * Events emitted:
 *   'trafficUpdate'  snapshot   after new perception data was processed
 *   'signalUpdate'   snapshot   whenever phase / plan / mode changes
 *   'systemEvent'    event      human-readable activity log entry
 */

const FIXED_ORDER = ['north', 'east', 'south', 'west'];
const MAX_EVENTS = 150;
const EXTENSION_SECONDS = 5;
const EXTEND_IF_SCORE_RATIO = 1.25;
// A preparing corridor waits for minimum green unless the vehicle is closer than this (s) beyond the change interval.
const CORRIDOR_MARGIN_SECONDS = 3;

const TYPE_LABEL = { ambulance: 'AMBULANCE', police: 'POLICE', fire_truck: 'FIRE TRUCK', emergency: 'EMERGENCY VEHICLE' };

const up = (dir) => (dir ? dir.toUpperCase() : '-');
const pct = (confidence) => `${Math.round(confidence * 100)}%`;
const round1 = (n) => Math.round(n * 10) / 10;
const typeLabel = (type) => TYPE_LABEL[type] || String(type || 'EMERGENCY').toUpperCase();

function perDirection(fn) {
  const out = {};
  for (const dir of DIRECTIONS) out[dir] = fn(dir);
  return out;
}

const nonNegative = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

const isCountMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An approach the producer has no source for (e.g. its video is missing). */
const unavailableApproach = () => ({
  vehicles: 0, queueLength: 0, waiting: 0, waitingTime: 0, available: false, classes: null, confidence: null,
});

/**
 * Defensive copy of one traffic observation. The REST validator already
 * guarantees the shape, but the engine may also be fed directly (e.g. by a
 * traffic-state store), so missing or non-numeric values become 0 rather
 * than NaN. Waiting time is accepted as `waiting` or `waitingTime` and is
 * exposed under both names. A null approach is unavailable: it adds no
 * demand here and is published as unavailable (null counts), never as zero.
 */
function normalizeObservation(data) {
  const traffic = perDirection((d) => {
    const raw = data.traffic ? data.traffic[d] : undefined;
    if (raw === null) return unavailableApproach();
    const e = raw || {};
    const waiting = nonNegative(e.waiting !== undefined ? e.waiting : e.waitingTime);
    return {
      vehicles: nonNegative(e.vehicles),
      queueLength: nonNegative(e.queueLength),
      waiting,
      waitingTime: waiting,
      available: true,
      classes: isCountMap(e.classes) ? { ...e.classes } : null,
      confidence: typeof e.confidence === 'number' && Number.isFinite(e.confidence) ? e.confidence : null,
    };
  });
  const pedestrians = perDirection((d) => Boolean(data.pedestrians) && data.pedestrians[d] === true);
  // Which detectors reported (POST /api/traffic sets this; a direct caller is
  // taken to report what it sent).
  const detectors = data.detectors
    ? { pedestrians: data.detectors.pedestrians === true, emergency: data.detectors.emergency === true }
    : { pedestrians: data.pedestrians !== undefined, emergency: data.emergency !== undefined };
  const em = data.emergency || {};
  const emergency = em.detected === true && DIRECTIONS.includes(em.direction)
    ? { detected: true, type: em.type || null, direction: em.direction, confidence: Math.min(1, nonNegative(em.confidence)) }
    : { detected: false, type: null, direction: null, confidence: 0 };
  return { traffic, pedestrians, emergency, detectors };
}

class TrafficDecisionService extends EventEmitter {
  /**
   * `dataMode` labels everything this instance produces ('live' or
   * 'simulation'). Instances share no state, so a simulation engine can never
   * influence the live one.
   */
  constructor({ intersections, config = defaultConfig, now = Date.now, dataMode = 'live' } = {}) {
    super();
    this.config = config;
    this.now = now;
    this.dataMode = dataMode;
    this.definitions = intersections;
    this.states = new Map();
    this.eventSeq = 0;
    this.timer = null;
    for (const def of intersections) this.states.set(def.id, this._createState(def));
  }

  /** Discards all state and returns every intersection to its initial condition. Timers are untouched. */
  reset() {
    this.states = new Map();
    this.eventSeq = 0;
    for (const def of this.definitions) this.states.set(def.id, this._createState(def));
  }

  // ------------------------------------------------------------------ public

  /**
   * Network advice for one intersection (from the network coordinator), or
   * null to return to local decisions:
   *   { cycle, scores: { dir: number }, blocked: { dir: bool }, notes: { dir: text } }
   */
  setNetworkAdvice(intersectionId, advice) {
    const s = this.states.get(intersectionId);
    if (!s) return false;
    s.network = advice
      ? {
        cycle: advice.cycle,
        scores: perDirection((d) => Math.max(0, Math.round(Number(advice.scores && advice.scores[d]) || 0))),
        blocked: perDirection((d) => Boolean(advice.blocked && advice.blocked[d])),
        notes: perDirection((d) => (advice.notes && advice.notes[d]) || null),
      }
      : null;
    return true;
  }

  /**
   * Emergency corridor directive (services/emergencyCorridor.js), or null:
   *   { vehicleId, type, direction, stage: 'preparing' | 'holding', etaSeconds, purpose: 'priority' | 'flush' }
   */
  setCorridorDirective(intersectionId, directive) {
    const s = this.states.get(intersectionId);
    if (!s) return false;
    const key = (d) => (d ? `${d.vehicleId}|${d.direction}|${d.stage}|${d.purpose || 'priority'}` : '');
    const prev = s.corridor;
    const next = directive
      ? {
        vehicleId: directive.vehicleId,
        type: directive.type || 'ambulance',
        direction: directive.direction,
        stage: directive.stage,
        etaSeconds: Number.isFinite(directive.etaSeconds) ? round1(directive.etaSeconds) : null,
        purpose: directive.purpose || 'priority',
      }
      : null;
    if (key(prev) !== key(next)) {
      if (next && next.purpose === 'flush') {
        this._log(s, 'PRIORITY', `Corridor support - clearing ${up(next.direction)} so ${typeLabel(next.type)} is not blocked downstream`, 'warning');
      } else if (next) {
        const eta = next.etaSeconds !== null ? `, ETA ${Math.round(next.etaSeconds)} s` : '';
        const what = next.stage === 'holding' ? 'green held' : 'preparing green';
        this._log(s, 'PRIORITY', `Emergency corridor - ${typeLabel(next.type)} approaching on ${up(next.direction)}${eta}: ${what}`, 'critical');
      } else if (prev) {
        this._log(s, 'PRIORITY', `Emergency corridor released (${typeLabel(prev.type)}) - returning to normal operation`);
      }
    }
    s.corridor = next;
    if (!next && s.holding === 'EMERGENCY' && !(s.emergency.active && !s.emergency.suppressed)) {
      s.holding = null;
      s.reason = `Corridor released - ${up(s.greenDirection)} green until the next decision`;
    }
    this._evaluate(s, this.now());
    this._emitSignalIfChanged(s);
    return true;
  }

  has(intersectionId) {
    return this.states.has(intersectionId);
  }

  ids() {
    return [...this.states.keys()];
  }

  priorityScore(entry) {
    const w = this.config.weights;
    return Math.round(entry.vehicles * w.vehicles + entry.waiting * w.waiting + entry.queueLength * w.queueLength);
  }

  listIntersections() {
    return [...this.states.values()].map((s) => {
      const snap = this._snapshot(s);
      return {
        dataMode: this.dataMode,
        id: s.id,
        name: s.name,
        lat: s.lat,
        lng: s.lng,
        positionSource: s.positionSource,
        grid: s.grid,
        mode: snap.mode,
        phase: snap.phase,
        greenDirection: snap.greenDirection,
        aiStatus: snap.aiStatus,
        emergency: snap.emergency.active
          ? { type: snap.emergency.type, direction: snap.emergency.direction }
          : null,
      };
    });
  }

  getSnapshot(intersectionId, { includeEvents = false } = {}) {
    const s = this.states.get(intersectionId);
    if (!s) return null;
    const snap = this._snapshot(s);
    if (includeEvents) snap.events = s.events.slice();
    return snap;
  }

  getAllSnapshots() {
    return [...this.states.values()].map((s) => this._snapshot(s));
  }

  /** Process one validated perception payload. Returns the new snapshot or null if unknown. */
  ingest(data) {
    const s = this.states.get(data.intersectionId);
    if (!s) return null;
    const now = this.now();

    const obs = normalizeObservation(data);
    this._logAvailability(s, obs.traffic);
    s.traffic = obs.traffic;
    s.pedestrians = obs.pedestrians;
    s.detectors = obs.detectors;
    s.detection = obs.emergency;
    s.scores = perDirection((d) => this.priorityScore(obs.traffic[d]));
    s.lastDataAt = now;
    s.sourceTimestamp = data.timestamp || new Date(now).toISOString();
    s.updatesReceived += 1;

    if (s.aiStatus !== 'CONNECTED') {
      const message = s.aiStatus === 'WAITING'
        ? 'Perception feed connected - adaptive control engaged'
        : 'Perception feed restored - adaptive control resumed';
      s.aiStatus = 'CONNECTED';
      this._log(s, 'AI DATA', message);
    }

    this._trackDemand(s, now);
    this._updatePedestrianRequests(s, now);
    this._updateEmergency(s, now);
    this._evaluate(s, now);

    const snap = this._snapshot(s);
    this.emit('trafficUpdate', snap);
    this._emitSignalIfChanged(s);
    return snap;
  }

  /** Advance every intersection's timers. Called on an interval by start(). */
  tick() {
    const now = this.now();
    for (const s of this.states.values()) {
      this._checkDataFreshness(s, now);
      this._evaluate(s, now);
      this._emitSignalIfChanged(s);
    }
  }

  start(intervalMs = 250) {
    this.stop();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------- state

  _createState(def) {
    const now = this.now();
    const s = {
      id: def.id,
      name: def.name,
      lat: def.lat,
      lng: def.lng,
      // 'surveyed' | 'placeholder' (config/intersections.js); simulated lists have none.
      positionSource: def.positionSource || null,
      grid: def.grid ? { col: def.grid.col, row: def.grid.row } : null,

      // Nothing measured yet: no demand. Published as null counts until the
      // first observation arrives (see _publicTraffic).
      traffic: perDirection(() => unavailableApproach()),
      pedestrians: perDirection(() => false),
      detectors: { pedestrians: false, emergency: false },
      scores: perDirection(() => 0),
      detection: { detected: false, type: null, direction: null, confidence: 0 },
      emergency: { active: false, type: null, direction: null, confidence: 0, since: null, suppressed: false, lastSeen: 0 },

      aiStatus: 'WAITING',
      lastDataAt: null,
      sourceTimestamp: null,
      updatesReceived: 0,

      mode: 'FALLBACK',
      phase: 'GREEN',
      greenDirection: 'north',
      next: null,
      holding: null,
      phaseStartedAt: now,
      phaseDuration: this.config.timing.FALLBACK_GREEN_TIME,
      signals: perDirection((d) => (d === 'north' ? 'GREEN' : 'RED')),
      pedestrianSignals: perDirection(() => 'DONT_WALK'),
      walkCrosswalks: [],
      pedRequestedAt: perDirection(() => null),
      pedLastSeen: perDirection(() => 0),
      pedCooldownUntil: 0,
      redSince: perDirection((d) => (d === 'north' ? null : now)),

      demandBaseline: perDirection(() => 0),
      lastDemandLogAt: perDirection(() => 0),
      lastCandidateLogAt: 0,

      network: null, // coordinator advice (setNetworkAdvice)
      corridor: null, // emergency corridor directive (setCorridorDirective)

      reason: 'Awaiting perception data - running fixed-time plan',
      events: [],
      lastSignature: null,
    };
    this._log(s, 'SYSTEM', 'Controller online - fixed-time plan until perception data arrives');
    return s;
  }

  _log(s, category, message, level = 'info') {
    const event = {
      id: ++this.eventSeq,
      dataMode: this.dataMode,
      intersectionId: s.id,
      time: new Date(this.now()).toISOString(),
      category,
      message,
      level,
    };
    s.events.push(event);
    if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
    this.emit('systemEvent', event);
  }

  _snapshot(s) {
    const now = this.now();
    const elapsed = (now - s.phaseStartedAt) / 1000;
    const serving = s.phase === 'GREEN' || s.phase === 'YELLOW' ? s.greenDirection : null;
    const em = s.emergency;
    const emActive = em.active && !em.suppressed;
    const candidate = s.detection.detected && !emActive ? s.detection : null;
    const nextDirection = s.next && s.next.type === 'GREEN' ? s.next.direction : null;
    const remaining = s.holding === 'EMERGENCY' ? null : Math.max(0, round1(s.phaseDuration - elapsed));

    return {
      dataMode: this.dataMode,
      intersectionId: s.id,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      positionSource: s.positionSource,
      grid: s.grid,

      // Compact decision summary. The flat fields below carry the same values
      // and are kept for existing clients.
      signal: {
        mode: s.mode,
        phase: s.phase,
        greenDirection: serving,
        nextDirection,
        greenTime: s.phase === 'GREEN' ? round1(s.phaseDuration) : null,
        remainingTime: remaining,
        holding: s.holding,
        reason: s.reason,
      },

      mode: s.mode,
      phase: s.phase,
      greenDirection: serving,
      nextDirection,
      nextPhase: s.next ? s.next.type : null,
      signals: { ...s.signals },
      pedestrianSignals: { ...s.pedestrianSignals },
      phaseDuration: round1(s.phaseDuration),
      elapsed: round1(elapsed),
      remaining,
      holding: s.holding,
      reason: s.reason,

      // Per approach: counts, or null counts with available=false when the
      // approach has no source or nothing was received yet.
      traffic: this._publicTraffic(s),
      pedestrians: { ...s.pedestrians },
      // Which detectors the AI service runs. False = not measured (the
      // matching fields above are not "none detected").
      detectors: { ...s.detectors },
      pedestrianRequests: perDirection((d) => s.pedRequestedAt[d] !== null),
      scores: { ...s.scores },
      redSeconds: perDirection((d) => (s.redSince[d] ? Math.round((now - s.redSince[d]) / 1000) : 0)),

      // `detected`/`active` = an emergency the controller is acting on (above
      // threshold). `observed` is the raw detection from the latest frame.
      emergency: {
        detected: emActive,
        active: emActive,
        type: emActive ? em.type : null,
        direction: emActive ? em.direction : null,
        confidence: emActive ? em.confidence : 0,
        since: emActive && em.since ? new Date(em.since).toISOString() : null,
        candidate: candidate
          ? { type: candidate.type, direction: candidate.direction, confidence: candidate.confidence }
          : null,
        threshold: this.config.EMERGENCY_CONFIDENCE_THRESHOLD,
        observed: { ...s.detection },
      },

      // Emergency corridor directive in force here (null = none).
      corridor: s.corridor ? { ...s.corridor } : null,
      // Network-aware scores in use (null = local decisions only).
      network: s.network
        ? { cycle: s.network.cycle, scores: { ...s.network.scores }, blocked: { ...s.network.blocked } }
        : null,

      aiStatus: s.aiStatus,
      lastUpdate: s.lastDataAt ? new Date(s.lastDataAt).toISOString() : null,
      sourceTimestamp: s.sourceTimestamp,
      updatesReceived: s.updatesReceived,
      serverTime: new Date(now).toISOString(),
    };
  }

  _signature(s) {
    const em = s.emergency;
    return [
      s.phase, s.greenDirection, s.mode, s.phaseStartedAt, s.phaseDuration, s.reason, s.aiStatus,
      s.holding, em.active, em.suppressed, em.direction, em.type,
      DIRECTIONS.map((d) => s.pedestrianSignals[d]).join(','),
      s.next ? `${s.next.type}:${s.next.direction || ''}` : '',
      s.corridor ? `${s.corridor.vehicleId}:${s.corridor.direction}:${s.corridor.stage}` : '',
    ].join('|');
  }

  _emitSignalIfChanged(s) {
    const sig = this._signature(s);
    if (sig === s.lastSignature) return;
    s.lastSignature = sig;
    this.emit('signalUpdate', this._snapshot(s));
  }

  _publicTraffic(s) {
    return perDirection((d) => {
      const t = s.traffic[d];
      if (!t.available || !s.updatesReceived) {
        return { vehicles: null, queueLength: null, waiting: null, waitingTime: null, available: false, classes: null, confidence: null };
      }
      return { ...t, classes: t.classes ? { ...t.classes } : null };
    });
  }

  // ------------------------------------------------------------ data inputs

  /** Logs approaches that lose or regain their source (e.g. a missing camera video). */
  _logAvailability(s, traffic) {
    for (const d of DIRECTIONS) {
      const was = s.updatesReceived ? s.traffic[d].available : true;
      const now = traffic[d].available;
      if (was && !now) this._log(s, 'AI DATA', `${up(d)} camera unavailable - no detections for this approach`, 'warning');
      else if (!was && now && s.updatesReceived) this._log(s, 'AI DATA', `${up(d)} camera available again`);
    }
  }

  _trackDemand(s, now) {
    for (const d of DIRECTIONS) {
      const score = s.scores[d];
      const base = s.demandBaseline[d];
      if (s.updatesReceived === 1 || score < base) {
        s.demandBaseline[d] = score;
        continue;
      }
      if (score - base >= 20 && score >= base * 1.4 && now - s.lastDemandLogAt[d] > 15000) {
        this._log(s, 'TRAFFIC', `${up(d)} demand increased (score ${base} -> ${score})`);
        s.demandBaseline[d] = score;
        s.lastDemandLogAt[d] = now;
      }
    }
  }

  _updatePedestrianRequests(s, now) {
    const hold = this.config.timing.PERCEPTION_HOLD_TIME * 1000;
    for (const d of DIRECTIONS) {
      if (!s.pedestrians[d]) {
        // A detection gap shorter than the hold time does not withdraw the
        // request (camera frames flicker); only a sustained absence does.
        if (now - s.pedLastSeen[d] > hold) s.pedRequestedAt[d] = null;
        continue;
      }
      s.pedLastSeen[d] = now;
      const crossingNow = s.pedestrianSignals[d] !== 'DONT_WALK';
      if (s.pedRequestedAt[d] === null && !crossingNow && now >= s.pedCooldownUntil) {
        s.pedRequestedAt[d] = now;
        this._log(s, 'PEDESTRIAN', `${up(d)} crossing requested`);
      }
    }
  }

  _updateEmergency(s, now) {
    const det = s.detection;
    const em = s.emergency;
    const threshold = this.config.EMERGENCY_CONFIDENCE_THRESHOLD;

    if (det.detected && det.confidence >= threshold) {
      if (!em.active || em.type !== det.type || em.direction !== det.direction) {
        Object.assign(em, {
          active: true, type: det.type, direction: det.direction,
          confidence: det.confidence, since: now, suppressed: false, lastSeen: now,
        });
        this._log(s, 'EMERGENCY', `${typeLabel(det.type)} detected ${up(det.direction)} (${pct(det.confidence)})`, 'critical');
      } else {
        em.confidence = det.confidence;
        em.lastSeen = now;
      }
    } else if (det.detected) {
      // Below threshold: keep an already-confirmed emergency on the same
      // approach (avoids flicker), but never start one from a weak detection.
      if (em.active && em.type === det.type && em.direction === det.direction) {
        em.confidence = det.confidence;
        em.lastSeen = now;
      } else if (now - s.lastCandidateLogAt > 5000) {
        s.lastCandidateLogAt = now;
        this._log(
          s, 'EMERGENCY',
          `${typeLabel(det.type)} candidate ${up(det.direction)} at ${pct(det.confidence)} - below ${pct(threshold)} threshold, not acted on`,
          'warning',
        );
      }
    } else if (em.active && now - em.lastSeen > this.config.timing.PERCEPTION_HOLD_TIME * 1000) {
      // Cleared only once the vehicle has been absent for the hold time, so a
      // few missed frames do not end (and then restart) the emergency.
      this._clearEmergency(s, 'Emergency cleared - returning to adaptive control');
    }
  }

  _clearEmergency(s, message) {
    Object.assign(s.emergency, {
      active: false, type: null, direction: null, confidence: 0, since: null, suppressed: false,
    });
    if (s.holding === 'EMERGENCY') {
      s.holding = null;
      s.reason = `Emergency cleared - ${up(s.greenDirection)} green until the next adaptive decision`;
    }
    this._log(s, 'EMERGENCY', message);
  }

  _checkDataFreshness(s, now) {
    if (s.aiStatus !== 'CONNECTED') return;
    const timeout = this.config.timing.DATA_TIMEOUT;
    if (now - s.lastDataAt <= timeout * 1000) return;

    s.aiStatus = 'STALE';
    this._log(s, 'AI DATA', `No perception data for ${timeout}s - fixed-time fallback engaged`, 'warning');
    if (s.emergency.active) this._clearEmergency(s, 'Emergency state expired - no fresh perception data');
    s.detection = { detected: false, type: null, direction: null, confidence: 0 };
    for (const d of DIRECTIONS) s.pedRequestedAt[d] = null;
  }

  // -------------------------------------------------------- state machine

  /**
   * The emergency this intersection acts on: a camera-confirmed vehicle
   * here first, otherwise an emergency corridor that is preparing or
   * holding green for an approaching vehicle.
   */
  _activeEmergency(s) {
    const em = s.emergency;
    if (em.active && !em.suppressed) return em;
    const c = s.corridor;
    if (c && (c.stage === 'preparing' || c.stage === 'holding')) {
      return {
        type: c.type, direction: c.direction, confidence: 1, corridor: true, stage: c.stage, eta: c.etaSeconds, purpose: c.purpose,
      };
    }
    return null;
  }

  _corridorReason(em, action) {
    if (em.purpose === 'flush') return `Emergency corridor support - clearing ${up(em.direction)} ahead of ${typeLabel(em.type)}: ${action}`;
    const eta = em.eta !== null && em.eta !== undefined ? ` (ETA ${Math.round(em.eta)} s)` : '';
    return `Emergency corridor - ${typeLabel(em.type)} on ${up(em.direction)}${eta}: ${action}`;
  }

  /** Scores used for decisions: network-aware when the coordinator supplied them. */
  _scoresFor(s) {
    return s.network ? s.network.scores : s.scores;
  }

  /** Text for choosing `best`, including why the locally busiest approach was not chosen. */
  _choiceReason(s, best) {
    if (!s.network) return `${up(best.direction)} has the highest traffic demand (score ${best.score})`;
    let text = `${up(best.direction)} has the highest network score (${best.score})`;
    const local = this._bestDirection(s, null, { local: true });
    const notes = s.network.notes;
    if (local && local.direction !== best.direction && notes[local.direction]) {
      text += ` - ${up(local.direction)} (local score ${local.score}) not first: ${notes[local.direction]}`;
    } else if (notes[best.direction]) {
      text += ` - ${notes[best.direction]}`;
    }
    return text;
  }

  _evaluate(s, now) {
    const em = s.emergency;
    const holdLimit = this.config.timing.EMERGENCY_MAX_HOLD_TIME;
    if (em.active && !em.suppressed && now - em.since > holdLimit * 1000) {
      em.suppressed = true;
      if (s.holding === 'EMERGENCY') s.holding = null;
      this._log(s, 'EMERGENCY', `Priority hold limit (${holdLimit}s) reached - resuming adaptive control`, 'warning');
    }

    // A few chained transitions may complete in one tick (e.g. after a pause).
    for (let i = 0; i < 6; i += 1) {
      if (!this._step(s, now)) break;
    }
    this._updateMode(s);
  }

  _updateMode(s) {
    let mode;
    if (this._activeEmergency(s)) mode = 'EMERGENCY';
    else if (s.phase === 'PED_WALK' || s.phase === 'PED_CLEAR') mode = 'PEDESTRIAN';
    else if (s.aiStatus !== 'CONNECTED') mode = 'FALLBACK';
    else mode = 'NORMAL';

    if (mode === s.mode) return;
    const prev = s.mode;
    s.mode = mode;
    if (mode !== 'PEDESTRIAN' && prev !== 'PEDESTRIAN') {
      this._log(s, 'SYSTEM', `Mode ${prev} -> ${mode}`, mode === 'EMERGENCY' ? 'critical' : 'info');
    }
  }

  _setPhase(s, phase, duration, now) {
    s.phase = phase;
    s.phaseDuration = duration;
    s.phaseStartedAt = now;
    s.holding = null;
  }

  _step(s, now) {
    const T = this.config.timing;
    const elapsed = (now - s.phaseStartedAt) / 1000;
    const em = this._activeEmergency(s);

    switch (s.phase) {
      case 'GREEN':
        return this._stepGreen(s, now, elapsed, em);

      case 'YELLOW':
        if (em) this._retargetForEmergency(s, em);
        if (elapsed < s.phaseDuration) return false;
        this._setPhase(s, 'ALL_RED', T.ALL_RED_TIME, now);
        s.signals[s.greenDirection] = 'RED';
        s.redSince[s.greenDirection] = now;
        return true;

      case 'ALL_RED':
        if (em) this._retargetForEmergency(s, em);
        if (elapsed < s.phaseDuration) return false;
        if (s.next && s.next.type === 'PED') this._beginPedWalk(s, s.next.crosswalks, now);
        else this._beginGreen(s, s.next ? s.next.direction : this._fixedNext(s.greenDirection), now, s.next && s.next.reason);
        return true;

      case 'PED_WALK':
        if (em) {
          this._beginPedClear(s, now);
          s.reason = `Walk shortened - ${typeLabel(em.type)} priority on ${up(em.direction)}`;
          this._log(s, 'PEDESTRIAN', 'Walk interval shortened for emergency - clearance in progress', 'warning');
          return true;
        }
        if (elapsed < s.phaseDuration) return false;
        this._beginPedClear(s, now);
        return true;

      case 'PED_CLEAR': {
        if (elapsed < s.phaseDuration) return false;
        s.pedestrianSignals = perDirection(() => 'DONT_WALK');
        s.walkCrosswalks = [];
        s.pedCooldownUntil = now + T.PEDESTRIAN_COOLDOWN * 1000;
        this._log(s, 'PEDESTRIAN', 'Crossing complete - vehicle phases resume');
        if (em) {
          this._beginGreen(s, em.direction, now, `Emergency priority - ${typeLabel(em.type)} on ${up(em.direction)}`);
        } else {
          const best = this._bestDirection(s, null);
          const dir = best ? best.direction : this._fixedNext(s.greenDirection);
          const reason = best
            ? `${up(dir)} has the highest traffic demand (score ${best.score})`
            : 'No measured demand - resuming fixed rotation';
          this._beginGreen(s, dir, now, reason);
        }
        return true;
      }

      default:
        return false;
    }
  }

  _stepGreen(s, now, elapsed, em) {
    const T = this.config.timing;
    const dir = s.greenDirection;

    // 1. Emergency priority overrides everything (including minimum green).
    if (em) {
      if (em.direction === dir) {
        s.holding = 'EMERGENCY';
        s.reason = em.corridor
          ? this._corridorReason(em, 'green held')
          : `Emergency priority - ${typeLabel(em.type)} on ${up(dir)} (${pct(em.confidence)}), green held`;
        return false;
      }
      // Staged corridor: a vehicle still far away waits for minimum green.
      if (em.corridor && em.stage === 'preparing' && elapsed < T.MIN_GREEN_TIME
        && (em.eta === null || em.eta > T.YELLOW_TIME + T.ALL_RED_TIME + CORRIDOR_MARGIN_SECONDS)) {
        s.reason = this._corridorReason(em, `${up(em.direction)} green after minimum green on ${up(dir)}`);
        return false;
      }
      const note = elapsed < T.MIN_GREEN_TIME ? ' (minimum green overridden)' : '';
      this._beginYellow(s, { type: 'GREEN', direction: em.direction }, now, em.corridor
        ? `${this._corridorReason(em, `switching to ${up(em.direction)}`)}${note}`
        : `Emergency preemption - ${typeLabel(em.type)} approaching from ${up(em.direction)}${note}`);
      return true;
    }
    if (s.holding === 'EMERGENCY') s.holding = null;

    // 2. No perception data: fixed-time rotation.
    if (s.aiStatus !== 'CONNECTED') {
      if (elapsed < s.phaseDuration) return false;
      const next = this._fixedNext(dir);
      this._beginYellow(s, { type: 'GREEN', direction: next }, now, `Fixed-time plan (no perception data) - ${up(next)} next`);
      return true;
    }

    // 3. Minimum green is always honoured in adaptive mode.
    if (elapsed < T.MIN_GREEN_TIME) return false;

    // 4. Pedestrian requests: served when this green's plan ends, or sooner
    //    if they have waited too long.
    const ped = this._pendingPedestrians(s, now);
    if (ped && (elapsed >= s.phaseDuration || ped.waited >= T.PEDESTRIAN_MAX_WAIT || elapsed >= T.MAX_GREEN_TIME)) {
      this._beginYellow(s, { type: 'PED', crosswalks: ped.crosswalks }, now,
        `Pedestrian crossing requested on ${ped.crosswalks.map(up).join(', ')} (waited ${Math.round(ped.waited)}s)`);
      return true;
    }

    // 5. Fairness: never let an approach with demand starve.
    const starving = this._starvingDirection(s, now, dir);
    if (starving) {
      this._beginYellow(s, { type: 'GREEN', direction: starving.direction }, now,
        `Fairness guard - ${up(starving.direction)} red for ${starving.seconds}s`);
      return true;
    }

    // 6. Adaptive: highest priority score wins (network-aware when advised).
    const best = this._bestDirection(s, dir);

    // Network: this green's exit road is (still) blocked downstream - stop
    // feeding it and serve an approach whose vehicles can move.
    if (s.network && s.network.blocked[dir] && best) {
      this._beginYellow(s, { type: 'GREEN', direction: best.direction }, now,
        `Network: ${up(dir)} exit blocked${s.network.notes[dir] ? ` (${s.network.notes[dir]})` : ''} - ${this._choiceReason(s, best)}`);
      return true;
    }
    if (!best) {
      if (elapsed >= s.phaseDuration) {
        s.phaseDuration = elapsed + EXTENSION_SECONDS;
        s.reason = `No competing demand - ${up(dir)} green extended`;
      }
      return false;
    }

    const current = s.traffic[dir];
    const currentScore = this._scoresFor(s)[dir];
    const target = { type: 'GREEN', direction: best.direction };
    const nextText = s.network
      ? this._choiceReason(s, best)
      : `${up(best.direction)} has the highest demand (score ${best.score})`;

    if (elapsed >= T.MAX_GREEN_TIME) {
      this._beginYellow(s, target, now, `Maximum green (${T.MAX_GREEN_TIME}s) reached on ${up(dir)} - ${nextText}`);
      return true;
    }
    if (current.vehicles === 0 && current.queueLength === 0) {
      this._beginYellow(s, target, now, `${up(dir)} approach cleared - ${nextText}`);
      return true;
    }
    if (elapsed >= s.phaseDuration) {
      if (currentScore > best.score * EXTEND_IF_SCORE_RATIO && elapsed + EXTENSION_SECONDS <= T.MAX_GREEN_TIME) {
        s.phaseDuration = elapsed + EXTENSION_SECONDS;
        s.reason = `${up(dir)} ${s.network ? 'network ' : ''}demand still highest (score ${currentScore} vs ${best.score}) - green extended`;
        return false;
      }
      this._beginYellow(s, target, now, this._choiceReason(s, best));
      return true;
    }
    return false;
  }

  _retargetForEmergency(s, em) {
    if (s.next && s.next.type === 'GREEN' && s.next.direction === em.direction) return;
    const reason = `Emergency preemption - ${typeLabel(em.type)} approaching from ${up(em.direction)}`;
    s.next = { type: 'GREEN', direction: em.direction, reason };
    s.reason = reason;
  }

  _beginYellow(s, next, now, reason) {
    this._setPhase(s, 'YELLOW', this.config.timing.YELLOW_TIME, now);
    s.signals[s.greenDirection] = 'YELLOW';
    s.next = { ...next, reason };
    s.reason = reason;
    this._log(s, 'DECISION', reason, next.type === 'GREEN' && this._activeEmergency(s) ? 'critical' : 'info');
  }

  _beginGreen(s, dir, now, reason) {
    const T = this.config.timing;
    const planned = s.aiStatus === 'CONNECTED'
      ? Math.min(T.MAX_GREEN_TIME, Math.max(T.MIN_GREEN_TIME, T.MIN_GREEN_TIME + s.traffic[dir].queueLength * T.SECONDS_PER_QUEUED_VEHICLE))
      : T.FALLBACK_GREEN_TIME;

    this._setPhase(s, 'GREEN', planned, now);
    s.greenDirection = dir;
    s.next = null;
    s.signals = perDirection((d) => (d === dir ? 'GREEN' : 'RED'));
    s.redSince[dir] = null;
    s.reason = reason || `${up(dir)} green`;

    const em = this._activeEmergency(s);
    if (em && em.direction === dir) {
      this._log(s, 'PRIORITY', `${up(dir)} -> GREEN (${typeLabel(em.type)} priority)`, 'critical');
    } else {
      this._log(s, 'SIGNAL', `${up(dir)} -> GREEN (${Math.round(planned)}s planned)`);
    }
  }

  _beginPedWalk(s, requested, now) {
    const T = this.config.timing;
    // Include requests that arrived while the vehicle phase was clearing.
    const pending = this._pendingPedestrians(s, now);
    const crosswalks = [...new Set([...(requested || []), ...(pending ? pending.crosswalks : [])])];

    this._setPhase(s, 'PED_WALK', T.MIN_PEDESTRIAN_CROSSING_TIME, now);
    s.next = null;
    s.signals = perDirection(() => 'RED');
    s.walkCrosswalks = crosswalks;
    for (const d of crosswalks) {
      s.pedestrianSignals[d] = 'WALK';
      s.pedRequestedAt[d] = null;
    }
    s.reason = `Pedestrian phase - all vehicle approaches held at red (${crosswalks.map(up).join(', ')} crossing)`;
    this._log(s, 'PEDESTRIAN', `${crosswalks.map(up).join(', ')} crossing - WALK ${T.MIN_PEDESTRIAN_CROSSING_TIME}s`);
  }

  _beginPedClear(s, now) {
    const T = this.config.timing;
    this._setPhase(s, 'PED_CLEAR', T.PEDESTRIAN_CLEARANCE_TIME, now);
    for (const d of s.walkCrosswalks) s.pedestrianSignals[d] = 'CLEARANCE';
    s.reason = `Pedestrian clearance - ${T.PEDESTRIAN_CLEARANCE_TIME}s before vehicles resume`;
  }

  _pendingPedestrians(s, now) {
    const crosswalks = DIRECTIONS.filter((d) => s.pedRequestedAt[d] !== null);
    if (!crosswalks.length) return null;
    const oldest = Math.min(...crosswalks.map((d) => s.pedRequestedAt[d]));
    return { crosswalks, waited: (now - oldest) / 1000 };
  }

  _starvingDirection(s, now, exclude) {
    const limit = this.config.timing.MAX_RED_TIME;
    let worst = null;
    for (const d of DIRECTIONS) {
      if (d === exclude || !s.redSince[d]) continue;
      const t = s.traffic[d];
      // An approach without a camera cannot show its demand, so it is still
      // served after the maximum red time (detector-failure recall).
      if (t.available && t.vehicles === 0 && t.queueLength === 0) continue;
      const seconds = Math.round((now - s.redSince[d]) / 1000);
      if (seconds >= limit && (!worst || seconds > worst.seconds)) worst = { direction: d, seconds };
    }
    return worst;
  }

  _bestDirection(s, exclude, { local = false } = {}) {
    const scores = local || !s.network ? s.scores : s.network.scores;
    const blocked = local || !s.network ? null : s.network.blocked;
    let best = null;
    for (const d of DIRECTIONS) {
      if (d === exclude || (blocked && blocked[d])) continue;
      const score = scores[d];
      if (score <= 0) continue;
      const red = s.redSince[d] ? s.redSince[d] : Infinity;
      if (!best || score > best.score || (score === best.score && red < best.red)) {
        best = { direction: d, score, red };
      }
    }
    return best ? { direction: best.direction, score: best.score } : null;
  }

  _fixedNext(dir) {
    return FIXED_ORDER[(FIXED_ORDER.indexOf(dir) + 1) % FIXED_ORDER.length];
  }
}

function createTrafficDecisionService(options) {
  return new TrafficDecisionService(options);
}

module.exports = { TrafficDecisionService, createTrafficDecisionService, normalizeObservation };
