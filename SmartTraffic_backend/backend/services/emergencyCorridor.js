const { DIRECTIONS } = require('../utils/validation');
const { OPPOSITE } = require('./networkTopology');

/**
 * Emergency corridor planner: prepares green, in stages, at the next N
 * intersections (default 3) along an emergency vehicle's route.
 *
 * Input: vehicle TRACKS (updateTrack):
 *   { id, type, source, towards, approach?, distanceM, speedMps?, route? }
 *     source    'simulation'  the Simulation tab's simulated vehicle (exact position)
 *               'camera'      a camera-confirmed detection at `towards`; the
 *                             route is ASSUMED to continue straight ahead and
 *                             the position is dead-reckoned at a nominal speed
 *               'gps'         reserved for a real tracking feed (not connected:
 *                             see docs - nothing in this repository sends it)
 *     towards   the next intersection the vehicle will reach
 *     approach  the side it enters `towards` from (derived from `route` when omitted)
 *     route     intended intersection ids in order (may include ones already
 *               passed); without it the vehicle is assumed to go straight
 *
 * Output of plan(view): per corridor the next N intersections with ETA,
 * stage and status, and per intersection one directive for the engine:
 *   planned    ETA beyond the prepare horizon - nothing changes yet
 *   preparing  ETA within CORRIDOR_PREPARE_SECONDS - green is arranged for
 *              the vehicle's approach, respecting minimum green while there
 *              is time (staged: the farther intersections start later)
 *   holding    the vehicle is close (ETA <= CORRIDOR_HOLD_SECONDS or within
 *              HOLD_DISTANCE_M) - its green is held
 *   passed     behind the vehicle - released to normal network control
 *
 * Safety / conflicts:
 *   - an intersection serves one corridor at a time: the earliest ETA wins;
 *     the other corridor is told why it was not served
 *   - a camera-confirmed emergency AT an intersection outranks a corridor
 *     there (the engine already holds that approach)
 *   - if the road a corridor intersection would send the vehicle into is
 *     blocked, it is reported, and the next intersection is asked to clear
 *     that road (a 'flush' directive) before the vehicle arrives
 */

const HOLD_DISTANCE_M = 40;
const PASSED_MARGIN_M = 10;

const round1 = (n) => Math.round(n * 10) / 10;

class EmergencyCorridorPlanner {
  constructor({ topology, settings = {}, now = Date.now }) {
    this.topology = topology;
    this.now = now;
    this.length = Math.max(1, Math.round(settings.CORRIDOR_LENGTH || 3));
    this.prepareSeconds = settings.CORRIDOR_PREPARE_SECONDS || 30;
    this.holdSeconds = settings.CORRIDOR_HOLD_SECONDS || 8;
    this.nominalSpeed = settings.CORRIDOR_NOMINAL_SPEED || 12;
    this.timeoutSeconds = settings.CORRIDOR_TRACK_TIMEOUT || 10;
    this.tracks = new Map();
  }

  /** Adds or updates a vehicle track. Returns { ok, error? }. */
  updateTrack(input) {
    const resolved = this._resolve(input);
    if (!resolved.ok) return resolved;
    const prev = this.tracks.get(input.id);
    const now = this.now();
    const track = {
      id: input.id,
      type: input.type || 'ambulance',
      source: input.source || 'simulation',
      speedMps: Number.isFinite(input.speedMps) && input.speedMps >= 0 ? input.speedMps : null,
      distanceM: Math.max(0, Number(input.distanceM) || 0),
      path: resolved.path, // [{ id, approach }] from `towards` onward
      exitHeading: resolved.exitHeading,
      routeAssumed: resolved.routeAssumed,
      passed: prev ? this._mergePassed(prev, resolved.path) : (resolved.passed || []),
      updatedAt: now,
      createdAt: prev ? prev.createdAt : now,
      rerouted: Boolean(prev && prev.path.map((p) => p.id).join('>') !== resolved.path.map((p) => p.id).join('>')),
    };
    this.tracks.set(track.id, track);
    return { ok: true, track: this._public(track, now) };
  }

  removeTrack(id) {
    return this.tracks.delete(id);
  }

  hasTrack(id) {
    return this.tracks.has(id);
  }

  /**
   * True when a vehicle with a reported position (not a camera estimate) is
   * already heading for `intersectionId` on `approach` - a camera seeing it
   * there is the same vehicle, not a second one.
   */
  isTracked(intersectionId, approach) {
    for (const t of this.tracks.values()) {
      if (t.source === 'camera') continue;
      const next = t.path[0];
      if (next && next.id === intersectionId && next.approach === approach) return true;
      if (t.passed[t.passed.length - 1] === intersectionId) return true; // just passed it
    }
    return false;
  }

  clear() {
    this.tracks.clear();
  }

  _mergePassed(prev, path) {
    const ahead = new Set(path.map((p) => p.id));
    const passed = [...prev.passed];
    for (const p of prev.path) if (!ahead.has(p.id) && !passed.includes(p.id)) passed.push(p.id);
    return passed.filter((id) => !ahead.has(id));
  }

  /** Route -> the intersections ahead with the approach used at each. */
  _resolve({ towards, approach, route }) {
    const topo = this.topology;
    if (typeof towards !== 'string' || !topo.has(towards)) return { ok: false, error: `unknown intersection "${towards}"` };
    if (approach !== undefined && approach !== null && !DIRECTIONS.includes(approach)) {
      return { ok: false, error: `approach must be one of ${DIRECTIONS.join(', ')}` };
    }

    if (Array.isArray(route) && route.length) {
      const idx = route.indexOf(towards);
      if (idx < 0) return { ok: false, error: `route does not contain "${towards}"` };
      for (let i = 0; i < route.length - 1; i += 1) {
        if (!topo.headingBetween(route[i], route[i + 1])) {
          return { ok: false, error: `route step ${route[i]} -> ${route[i + 1]} is not a road in the network` };
        }
      }
      const ids = route.slice(idx);
      let firstApproach = approach || null;
      if (!firstApproach && idx > 0) firstApproach = OPPOSITE[topo.headingBetween(route[idx - 1], towards)];
      if (!firstApproach) return { ok: false, error: 'approach is required when the route starts at "towards"' };
      const path = [{ id: ids[0], approach: firstApproach }];
      for (let i = 0; i < ids.length - 1; i += 1) {
        path.push({ id: ids[i + 1], approach: OPPOSITE[topo.headingBetween(ids[i], ids[i + 1])] });
      }
      const last = ids.length > 1 ? topo.headingBetween(ids[ids.length - 2], ids[ids.length - 1]) : OPPOSITE[firstApproach];
      return { ok: true, path, exitHeading: last, routeAssumed: false, passed: route.slice(0, idx) };
    }

    if (!approach) return { ok: false, error: 'approach is required without a route' };
    // No route: straight ahead in the travel direction (assumed).
    const heading = OPPOSITE[approach];
    const path = [{ id: towards, approach }];
    let id = towards;
    const seen = new Set([towards]);
    for (;;) {
      const next = topo.neighbors[id][heading];
      if (!next || seen.has(next)) break;
      seen.add(next);
      path.push({ id: next, approach });
      id = next;
    }
    return { ok: true, path, exitHeading: heading, routeAssumed: true, passed: [] };
  }

  /** Remaining intersections with distance / ETA, after dead-reckoning since the last update. */
  _progress(track, now) {
    const speed = track.speedMps !== null && track.speedMps > 0.5 ? track.speedMps : null;
    const assumed = speed === null;
    const v = speed || this.nominalSpeed;
    // Dead reckoning only for estimated (camera) tracks; reported positions are used as is.
    const travelled = track.source === 'camera' ? ((now - track.updatedAt) / 1000) * v : 0;
    const out = [];
    let distance = track.distanceM - travelled;
    for (let i = 0; i < track.path.length; i += 1) {
      if (i > 0) distance += this.topology.linkLengthM;
      out.push({
        ...track.path[i],
        distanceM: round1(distance),
        etaSeconds: distance <= 0 ? 0 : round1(distance / v),
        etaEstimated: assumed,
      });
    }
    return out;
  }

  _expired(track, now, remaining) {
    const age = (now - track.updatedAt) / 1000;
    if (track.source === 'camera') {
      // Dead-reckoned: kept until its estimated position has passed the last intersection ahead.
      const last = remaining[remaining.length - 1];
      return !last || last.distanceM < -PASSED_MARGIN_M || age > this.timeoutSeconds + 60;
    }
    return age > this.timeoutSeconds;
  }

  _stage(entry) {
    if (entry.distanceM <= HOLD_DISTANCE_M || entry.etaSeconds <= this.holdSeconds) return 'holding';
    if (entry.etaSeconds <= this.prepareSeconds) return 'preparing';
    return 'planned';
  }

  /**
   * @param view  network view from the coordinator ({ intersections, links } keyed by id)
   * @returns {{ corridors: object[], directives: Map<string, object>, lost: string[] }}
   */
  plan(view) {
    const now = this.now();
    const lost = [];
    const requests = new Map(); // intersectionId -> [{ corridor, entry }]
    const corridors = [];

    for (const track of [...this.tracks.values()]) {
      const remaining = this._progress(track, now);
      if (this._expired(track, now, remaining)) {
        this.tracks.delete(track.id);
        lost.push(track.id);
        continue;
      }
      const ahead = remaining.filter((e) => e.distanceM >= -PASSED_MARGIN_M);
      const justPassed = remaining.filter((e) => e.distanceM < -PASSED_MARGIN_M).map((e) => e.id);
      const entries = ahead.slice(0, this.length).map((e, i) => {
        const next = ahead[i + 1] || null;
        const exitHeading = next ? this.topology.headingBetween(e.id, next.id) : track.exitHeading;
        const exitTo = exitHeading ? this.topology.neighbors[e.id][exitHeading] : null;
        return {
          intersectionId: e.id,
          approach: e.approach,
          distanceM: e.distanceM,
          etaSeconds: e.etaSeconds,
          etaEstimated: e.etaEstimated,
          stage: this._stage(e),
          exitTo,
          exitLink: exitTo ? `${e.id}>${exitTo}` : null,
          status: 'ok',
          reason: null,
        };
      });
      const corridor = {
        vehicleId: track.id,
        type: track.type,
        source: track.source,
        routeAssumed: track.routeAssumed,
        speedMps: track.speedMps,
        heading: track.exitHeading,
        rerouted: track.rerouted,
        position: ahead[0] ? { towards: ahead[0].id, approach: ahead[0].approach, distanceM: ahead[0].distanceM } : null,
        route: [...track.passed, ...justPassed, ...ahead.map((e) => e.id)],
        passed: [...track.passed, ...justPassed],
        entries,
        support: [],
      };
      corridors.push(corridor);
      for (const entry of entries) {
        if (!requests.has(entry.intersectionId)) requests.set(entry.intersectionId, []);
        requests.get(entry.intersectionId).push({ corridor, entry });
      }
    }

    const directives = new Map();
    for (const [id, list] of requests) {
      list.sort((a, b) => a.entry.etaSeconds - b.entry.etaSeconds);
      const [winner, ...others] = list;
      for (const o of others) {
        if (o.entry.approach === winner.entry.approach) continue; // same green serves both
        o.entry.status = 'conflict';
        o.entry.reason = `yields to ${winner.corridor.type} ${winner.corridor.vehicleId} on ${winner.entry.approach} (ETA ${winner.entry.etaSeconds} s, earlier)`;
      }
      const ix = view && view.intersections ? view.intersections[id] : null;
      const camera = ix && ix.cameraEmergency;
      if (camera && camera.direction !== winner.entry.approach) {
        winner.entry.status = 'conflict';
        winner.entry.reason = `camera-confirmed ${camera.type} on ${camera.direction} has priority here`;
        continue;
      }
      const exit = winner.entry.exitLink && view && view.links ? view.links[winner.entry.exitLink] : null;
      if (exit && exit.state === 'blocked') {
        winner.entry.status = 'exit-blocked';
        winner.entry.reason = `road to ${winner.entry.exitTo} is blocked (${exit.queue}/${exit.capacity} queued) - ${winner.entry.exitTo} asked to clear it first`;
        const inCorridor = winner.corridor.entries.some((e) => e.intersectionId === winner.entry.exitTo);
        if (!inCorridor && !requests.has(winner.entry.exitTo)) {
          directives.set(winner.entry.exitTo, {
            vehicleId: winner.corridor.vehicleId,
            type: winner.corridor.type,
            direction: exit.approach,
            stage: 'preparing',
            etaSeconds: winner.entry.etaSeconds,
            purpose: 'flush',
          });
          winner.corridor.support.push({ intersectionId: winner.entry.exitTo, approach: exit.approach, purpose: 'flush' });
        }
      }
      if (ix && !ix.fresh && winner.entry.status === 'ok') {
        winner.entry.status = 'no-data';
        winner.entry.reason = 'no traffic data - signal timing only';
      }
      if (winner.entry.stage === 'planned') continue;
      directives.set(id, {
        vehicleId: winner.corridor.vehicleId,
        type: winner.corridor.type,
        direction: winner.entry.approach,
        stage: winner.entry.stage,
        etaSeconds: winner.entry.etaSeconds,
        purpose: 'priority',
      });
    }
    return { corridors, directives, lost };
  }

  _public(track, now) {
    return {
      id: track.id,
      type: track.type,
      source: track.source,
      routeAssumed: track.routeAssumed,
      path: track.path.map((p) => ({ ...p })),
      ahead: this._progress(track, now),
    };
  }
}

function createEmergencyCorridorPlanner(options) {
  return new EmergencyCorridorPlanner(options);
}

module.exports = { EmergencyCorridorPlanner, createEmergencyCorridorPlanner, HOLD_DISTANCE_M };
