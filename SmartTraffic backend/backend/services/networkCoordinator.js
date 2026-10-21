const EventEmitter = require('events');
const { DIRECTIONS } = require('../utils/validation');
const { createEmergencyCorridorPlanner } = require('./emergencyCorridor');

/**
 * Network coordinator - makes the intersections of one channel (live or
 * simulation) work as one network.
 *
 * Every DECISION_INTERVAL seconds (one "cycle") it:
 *   1. reads every intersection's latest snapshot from the decision engine
 *   2. builds a network view: per intersection its data status and queues,
 *      per directed road (topology link) the queue waiting at its far end
 *   3. scores every approach of every intersection with fresh data:
 *
 *        network = local x capacity - DOWNSTREAM_WEIGHT x downstream queue
 *                  + UPSTREAM_WEIGHT x platoon
 *
 *        local      the engine's own score (vehicles, wait, queue)
 *        capacity   1 while the road the approach feeds stays below
 *                   SPILLBACK_START occupancy after LOOKAHEAD_RELEASE_SHARE
 *                   of one green's release (one-phase lookahead; the far
 *                   end discharges meanwhile), falling to 0 at
 *                   SPILLBACK_BLOCK
 *
 *      Defaults were chosen with the controlled benchmark (15 scenario /
 *      seed cases): versus per-intersection adaptive control they cut
 *      spillback by about 40% with about the same total delay on average
 *      (individual cases range from about 15% better to 18% worse).
 *        downstream vehicles already queued at the far end of that road
 *                   (max-pressure: release where vehicles can move)
 *        platoon    vehicles the upstream neighbour is releasing toward
 *                   this approach right now (green wave)
 *
 *      An approach whose exit road stays above SPILLBACK_BLOCK for
 *      BLOCKED_CYCLES cycles is "blocked": it is not served, and a green it
 *      holds is ended (after minimum green) so it stops feeding the jam.
 *   4. plans emergency corridors (services/emergencyCorridor.js)
 *   5. hands scores and corridor directives to the engine, which keeps all
 *      safety timing (one approach green, yellow, all-red, minimum green)
 *   6. emits 'decision' with what was measured, considered and chosen, and
 *      whether the engine applied it
 *
 * Missing or stale data is never treated as zero: an intersection without
 * fresh data gets no advice (its engine stays on its own plan), and a road
 * whose far end has no data is "unknown" - neither penalised nor preferred.
 */

const DEFAULTS = {
  DECISION_INTERVAL: 2,
  SPILLBACK_START: 0.7,
  SPILLBACK_BLOCK: 0.9,
  DOWNSTREAM_WEIGHT: 0.5,
  UPSTREAM_WEIGHT: 2,
  SATURATION_FLOW: 1.35,
  BLOCKED_CYCLES: 2,
  MAX_PLATOON: 10,
  // Share of one green's release added to the downstream queue in the
  // one-phase lookahead (the far end discharges at the same time, so the
  // full release overstates the risk).
  LOOKAHEAD_RELEASE_SHARE: 0.3,
};
const HISTORY = 30;

const up = (d) => (d ? d.toUpperCase() : '-');
const round = (n, k = 0) => Math.round(n * 10 ** k) / 10 ** k;

function linkState(occupancy, start, block) {
  if (occupancy === null) return 'unknown';
  if (occupancy >= block) return 'blocked';
  if (occupancy >= start) return 'congested';
  if (occupancy >= 0.3) return 'busy';
  return 'free';
}

class NetworkCoordinator extends EventEmitter {
  constructor({
    engine, topology, config, now = Date.now, dataMode = 'live', enabled = true, cameraCorridors = true,
  }) {
    super();
    this.engine = engine;
    this.topology = topology;
    this.config = config;
    this.settings = { ...DEFAULTS, ...(config.network || {}) };
    this.now = now;
    this.dataMode = dataMode;
    this.enabled = enabled;
    this.cameraCorridors = cameraCorridors;
    this.planner = createEmergencyCorridorPlanner({ topology, settings: this.settings, now });
    this.cycleNo = 0;
    this.timer = null;
    this.blockedCount = new Map(); // `${id}:${dir}` -> consecutive blocked cycles
    this.directiveKeys = new Map(); // id -> last directive key sent
    this.advised = new Set(); // intersections currently holding advice
    this.latest = null;
    this.history = [];
  }

  start(intervalMs = this.settings.DECISION_INTERVAL * 1000) {
    this.stop();
    this.timer = setInterval(() => this.cycle(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Turns network optimisation on / off; off = every intersection decides alone. */
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      for (const id of this.advised) this.engine.setNetworkAdvice(id, null);
      this.advised.clear();
    }
    return this.enabled;
  }

  /** Forget everything (simulation reset). */
  reset() {
    this.planner.clear();
    this.blockedCount.clear();
    this.directiveKeys.clear();
    this.advised.clear();
    this.cycleNo = 0;
    this.latest = null;
    this.history = [];
  }

  // ----------------------------------------------------------------- view

  /** Snapshot of the whole network as the coordinator sees it. */
  buildView() {
    const { SPILLBACK_START, SPILLBACK_BLOCK } = this.settings;
    const intersections = {};
    for (const snap of this.engine.getAllSnapshots()) {
      const fresh = snap.aiStatus === 'CONNECTED';
      const approaches = {};
      for (const d of DIRECTIONS) {
        const t = snap.traffic[d];
        const available = fresh && t && t.available !== false && Number.isFinite(t.queueLength);
        approaches[d] = {
          available,
          vehicles: available ? t.vehicles : null,
          queue: available ? t.queueLength : null,
          wait: available ? (Number.isFinite(t.waitingTime) ? t.waitingTime : t.waiting) : null,
          local: available ? (snap.scores ? snap.scores[d] : 0) : 0,
        };
      }
      intersections[snap.intersectionId] = {
        id: snap.intersectionId,
        name: snap.name,
        fresh,
        status: fresh ? (snap.dataMode === 'simulation' ? 'simulated' : 'live') : (snap.aiStatus === 'STALE' ? 'stale' : 'nodata'),
        mode: snap.mode,
        phase: snap.phase,
        green: snap.phase === 'GREEN' ? snap.greenDirection : null,
        serving: snap.greenDirection,
        next: snap.nextDirection,
        remaining: snap.remaining,
        elapsed: snap.elapsed,
        approaches,
        cameraEmergency: snap.emergency && snap.emergency.active
          ? { type: snap.emergency.type, direction: snap.emergency.direction }
          : null,
        corridor: snap.corridor,
      };
    }
    const links = {};
    for (const l of this.topology.links) {
      const far = intersections[l.to];
      const a = far ? far.approaches[l.approach] : null;
      const queue = a && a.available ? a.queue : null;
      const occupancy = queue === null ? null : queue / l.capacity;
      const from = intersections[l.from];
      links[l.id] = {
        ...l,
        queue,
        occupancy: occupancy === null ? null : round(occupancy, 2),
        state: linkState(occupancy, SPILLBACK_START, SPILLBACK_BLOCK),
        // Vehicles are being released onto this road right now.
        releasing: Boolean(from && from.phase === 'GREEN' && from.serving === l.approach),
      };
    }
    return { intersections, links };
  }

  // ------------------------------------------------------------- scoring

  _plannedGreen(queue) {
    const T = this.config.timing;
    return Math.min(T.MAX_GREEN_TIME, Math.max(T.MIN_GREEN_TIME, T.MIN_GREEN_TIME + queue * T.SECONDS_PER_QUEUED_VEHICLE));
  }

  /** Candidates (one per approach) for one intersection with fresh data. */
  _candidates(view, ix) {
    const S = this.settings;
    const name = (id) => (view.intersections[id] ? view.intersections[id].name : id);
    return DIRECTIONS.map((d) => {
      const a = ix.approaches[d];
      const c = {
        approach: d, available: a.available, queue: a.queue, vehicles: a.vehicles, local: a.local,
        network: a.local, factor: 1, downstream: null, upstream: null, platoon: 0, blocked: false, note: null, notes: [],
      };
      if (!a.available) {
        delete c.notes;
        return c;
      }

      let penalty = 0;
      const down = this.topology.downstreamOf(ix.id, d);
      if (down) {
        const link = view.links[down.link.id];
        const release = Math.min(a.queue, Math.round(S.SATURATION_FLOW * this._plannedGreen(a.queue)));
        c.downstream = {
          to: down.to, toName: name(down.to), link: down.link.id, queue: link.queue, capacity: link.capacity,
          occupancy: link.occupancy, state: link.state, release,
        };
        if (link.queue === null) {
          c.notes.push(`exit to ${name(down.to)} has no data`);
        } else {
          const projected = (link.queue + S.LOOKAHEAD_RELEASE_SHARE * release) / link.capacity;
          if (projected >= S.SPILLBACK_BLOCK) c.factor = 0;
          else if (projected > S.SPILLBACK_START) c.factor = 1 - (projected - S.SPILLBACK_START) / (S.SPILLBACK_BLOCK - S.SPILLBACK_START);
          c.factor = round(c.factor, 2);
          penalty = S.DOWNSTREAM_WEIGHT * link.queue;
          const key = `${ix.id}:${d}`;
          const count = link.state === 'blocked' ? (this.blockedCount.get(key) || 0) + 1 : 0;
          this.blockedCount.set(key, count);
          c.blocked = count >= S.BLOCKED_CYCLES;
          if (c.blocked) c.notes.push(`exit to ${name(down.to)} blocked (${link.queue}/${link.capacity} queued)`);
          else if (c.factor < 1) c.notes.push(`exit to ${name(down.to)} congested (${link.queue}/${link.capacity} queued, ${release} more would be released)`);
        }
      }

      const upstream = this.topology.upstreamOf(ix.id, d);
      if (upstream) {
        const u = view.intersections[upstream.from];
        c.upstream = { from: upstream.from, fromName: name(upstream.from), releasing: false, queue: null };
        if (u && u.fresh) {
          const uq = u.approaches[d].queue;
          c.upstream.queue = uq;
          if (u.phase === 'GREEN' && u.serving === d && uq) {
            c.upstream.releasing = true;
            c.platoon = Math.min(uq, S.MAX_PLATOON);
            c.notes.push(`${c.platoon} vehicles arriving from ${name(upstream.from)}`);
          }
        }
      }

      c.network = c.blocked ? 0 : Math.max(0, Math.round(a.local * c.factor - penalty + S.UPSTREAM_WEIGHT * c.platoon));
      c.note = c.notes.length ? c.notes.join('; ') : null;
      delete c.notes;
      return c;
    });
  }

  // ------------------------------------------------------------ the cycle

  cycle() {
    this.cycleNo += 1;
    const at = this.now();
    const view = this.buildView();

    // Camera-confirmed emergencies become (estimated) corridor tracks.
    if (this.cameraCorridors) {
      for (const ix of Object.values(view.intersections)) {
        if (!ix.cameraEmergency || !ix.cameraEmergency.direction) continue;
        const trackId = `camera:${ix.id}:${ix.cameraEmergency.direction}`;
        // The camera sees a vehicle that already reports its position: one vehicle, one corridor.
        if (this.planner.isTracked(ix.id, ix.cameraEmergency.direction)) {
          this.planner.removeTrack(trackId);
          continue;
        }
        this.planner.updateTrack({
          id: trackId,
          type: ix.cameraEmergency.type,
          source: 'camera',
          towards: ix.id,
          approach: ix.cameraEmergency.direction,
          distanceM: 0,
          speedMps: null,
        });
      }
    }
    const plan = this.planner.plan(view);

    // Corridor directives: sent on change (and with the latest ETA while active).
    for (const id of Object.keys(view.intersections)) {
      const d = plan.directives.get(id) || null;
      const key = d ? `${d.vehicleId}|${d.direction}|${d.stage}|${d.purpose}|${Math.round(d.etaSeconds || 0)}` : '';
      if ((this.directiveKeys.get(id) || '') === key) continue;
      this.directiveKeys.set(id, key);
      this.engine.setCorridorDirective(id, d);
    }

    // Network advice for every intersection with fresh data.
    const decisions = [];
    for (const ix of Object.values(view.intersections)) {
      if (!ix.fresh) {
        if (this.advised.has(ix.id)) {
          this.engine.setNetworkAdvice(ix.id, null);
          this.advised.delete(ix.id);
        }
        decisions.push(this._describeIdle(ix));
        continue;
      }
      const candidates = this._candidates(view, ix);
      if (this.enabled) {
        this.engine.setNetworkAdvice(ix.id, {
          cycle: this.cycleNo,
          scores: Object.fromEntries(candidates.map((c) => [c.approach, c.network])),
          blocked: Object.fromEntries(candidates.map((c) => [c.approach, c.blocked])),
          notes: Object.fromEntries(candidates.map((c) => [c.approach, c.note])),
        });
        this.advised.add(ix.id);
      }
      decisions.push({ ix, candidates });
    }

    // Let the engines act on the new inputs now, then record what they did.
    this.engine.tick();
    const after = Object.fromEntries(this.engine.getAllSnapshots().map((s) => [s.intersectionId, s]));
    const records = decisions.map((d) => (d.ix ? this._describe(view, d.ix, d.candidates, after[d.ix.id], plan) : d));

    const decision = {
      dataMode: this.dataMode,
      cycle: this.cycleNo,
      at: new Date(at).toISOString(),
      enabled: this.enabled,
      method: 'network pressure scoring with one-phase lookahead and spillback guard',
      evaluated: records.filter((r) => r.evaluated).map((r) => r.intersectionId),
      intersections: records,
      links: Object.values(view.links).map((l) => ({
        id: l.id, from: l.from, to: l.to, heading: l.heading, approach: l.approach,
        queue: l.queue, capacity: l.capacity, occupancy: l.occupancy, state: l.state, releasing: l.releasing,
      })),
      corridors: plan.corridors,
      lostTracks: plan.lost,
    };
    this.latest = decision;
    this.history.push({ cycle: decision.cycle, at: decision.at, actions: records.filter((r) => r.changed).map((r) => ({ id: r.intersectionId, action: r.action })) });
    if (this.history.length > HISTORY) this.history.shift();
    this.emit('decision', decision);
    return decision;
  }

  _describeIdle(ix) {
    return {
      intersectionId: ix.id,
      name: ix.name,
      status: ix.status,
      evaluated: false,
      mode: ix.mode,
      phase: ix.phase,
      green: ix.serving,
      measurements: null,
      candidates: [],
      recommended: null,
      action: ix.corridor ? `Emergency corridor: ${ix.corridor.stage} ${up(ix.corridor.direction)}` : 'Own fixed-time plan',
      reason: ix.status === 'stale'
        ? 'AI data stale - not optimised; its numbers are not used by neighbours'
        : 'No traffic data - not optimised; neighbours treat its roads as unknown',
      emergency: Boolean(ix.corridor),
      applied: ix.corridor ? 'applied' : 'n/a',
      changed: false,
    };
  }

  _describe(view, ix, candidates, after, plan) {
    const usable = candidates.filter((c) => c.available);
    const byScore = (key) => [...usable].filter((c) => c[key] > 0 && !(key === 'network' && c.blocked))
      .sort((a, b) => b[key] - a[key])[0] || null;
    const rec = byScore('network');
    const localBest = byScore('local');
    const corridorEntry = plan.corridors.flatMap((c) => c.entries.map((e) => ({ c, e }))).find(({ e }) => e.intersectionId === ix.id);
    const green = ix.phase === 'GREEN' ? ix.serving : null;
    const greenCand = green ? candidates.find((c) => c.approach === green) : null;

    let action;
    let reason;
    let recommended = rec ? rec.approach : null;
    if (after && after.corridor) {
      recommended = after.corridor.direction;
      action = after.corridor.purpose === 'flush'
        ? `Clear ${up(after.corridor.direction)} for the emergency corridor`
        : `Emergency corridor: ${after.corridor.stage} ${up(after.corridor.direction)} green`;
      reason = corridorEntry
        ? `${corridorEntry.c.type} ${corridorEntry.c.vehicleId}, ETA ${corridorEntry.e.etaSeconds} s${corridorEntry.e.etaEstimated ? ' (estimated)' : ''}${corridorEntry.e.reason ? ` - ${corridorEntry.e.reason}` : ''}`
        : 'support action for an emergency corridor';
    } else if (ix.cameraEmergency) {
      recommended = ix.cameraEmergency.direction;
      action = `Emergency priority on ${up(ix.cameraEmergency.direction)} (camera)`;
      reason = `${ix.cameraEmergency.type} confirmed by the camera at this intersection`;
    } else if (!this.enabled) {
      action = 'Local control (network optimisation off)';
      reason = 'Network optimisation is turned off - this intersection decides from its own data only';
    } else if (greenCand && greenCand.blocked && rec) {
      action = `End ${up(green)} green early, then ${up(rec.approach)}`;
      reason = `${greenCand.note}; releasing more would block the road`;
    } else if (!rec) {
      action = green ? `Keep ${up(green)} green` : 'Hold current plan';
      reason = usable.length ? 'No approach with demand that can be released' : 'No approach data';
    } else {
      action = green && rec.approach === green
        ? `Keep ${up(green)} green`
        : green ? `Next green: ${up(rec.approach)} (after ${up(green)})` : `Next green: ${up(rec.approach)}`;
      if (localBest && localBest.approach !== rec.approach) {
        const lb = candidates.find((c) => c.approach === localBest.approach);
        reason = `${up(lb.approach)} has the largest local demand (score ${lb.local}) but ${lb.note || 'a lower network score'}; `
          + `${up(rec.approach)} has the highest network score (${rec.network})`;
      } else {
        reason = `highest network score (${rec.network})${rec.note ? ` - ${rec.note}` : ''}`;
      }
    }

    // Did the engine follow it?
    let applied = 'applied';
    if (after) {
      const serving = after.phase === 'GREEN' || after.phase === 'YELLOW' ? after.greenDirection : null;
      const ok = !recommended || serving === recommended || after.nextDirection === recommended
        || (after.phase === 'ALL_RED' && after.nextDirection === recommended);
      if (!ok) {
        if (after.mode === 'PEDESTRIAN') applied = 'overridden: pedestrian phase';
        else if (after.mode === 'EMERGENCY') applied = 'overridden: emergency priority';
        else if (after.phase === 'GREEN' && after.elapsed < this.config.timing.MIN_GREEN_TIME) applied = 'pending: minimum green';
        else if (after.phase === 'GREEN') applied = 'pending: current green still has demand';
        else applied = 'pending: change interval';
      }
    }

    const measured = usable.reduce((m, c) => ({
      vehicles: m.vehicles + (c.vehicles || 0), queued: m.queued + (c.queue || 0),
    }), { vehicles: 0, queued: 0 });
    const neighbours = new Set();
    for (const c of candidates) {
      if (c.downstream && c.downstream.queue !== null) neighbours.add(c.downstream.to);
      if (c.upstream && c.upstream.queue !== null) neighbours.add(c.upstream.from);
    }
    const prev = this.latest ? this.latest.intersections.find((r) => r.intersectionId === ix.id) : null;
    return {
      intersectionId: ix.id,
      name: ix.name,
      status: ix.status,
      evaluated: true,
      mode: after ? after.mode : ix.mode,
      phase: after ? after.phase : ix.phase,
      green: after ? after.greenDirection : ix.serving,
      remaining: after ? after.remaining : ix.remaining,
      measurements: measured,
      considered: [ix.id, ...neighbours],
      candidates,
      recommended,
      localBest: localBest ? localBest.approach : null,
      networkChangedChoice: Boolean(rec && localBest && rec.approach !== localBest.approach),
      action,
      reason,
      emergency: Boolean((after && after.corridor) || ix.cameraEmergency),
      applied,
      changed: !prev || prev.action !== action,
    };
  }
}

function createNetworkCoordinator(options) {
  return new NetworkCoordinator(options);
}

module.exports = { NetworkCoordinator, createNetworkCoordinator, linkState };
