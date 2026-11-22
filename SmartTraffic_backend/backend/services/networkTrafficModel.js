const { DIRECTIONS } = require('../utils/validation');
const { OPPOSITE } = require('./networkTopology');

/**
 * Store-and-forward traffic model of the road network - SIMULATION ONLY
 * (the Simulation tab and the controlled benchmark). It never touches live
 * state.
 *
 *   queue     vehicles stopped at an approach (arrival time each)
 *   transit   vehicles driving along a link toward the next intersection
 *
 * Every simulated second:
 *   1. vehicles whose travel time on a link is over join the queue at its far end
 *   2. each green approach releases vehicles (SATURATION_FLOW veh/s, yellow
 *      YELLOW_FLOW) - but only as many as fit on the road ahead: a link holds
 *      at most `capacity` vehicles (queued at its far end + in transit). A
 *      green approach that cannot release because its exit is full is a
 *      SPILLBACK (counted). Released vehicles enter the link, or leave the
 *      network where there is no managed intersection ahead.
 * Only through movements are modelled. Discharge is random (Simulation tab)
 * or deterministic (benchmark, so policies are compared on equal terms).
 *
 * Emergency vehicles follow a route of intersections at their own speed,
 * pass queues (traffic yields) and stop only at a red signal or when the
 * road ahead is full.
 */

const DEFAULTS = {
  satFlow: 1.35,
  yellowFlow: 0.5,
  speedMps: 11, // ordinary traffic on a link
  emergencySpeedMps: 14,
  cameraRangeM: 60, // an emergency vehicle this close to an intersection is seen by its camera
};

function createNetworkTrafficModel({ topology, ids, random = null, settings = {} }) {
  const S = { ...DEFAULTS, ...settings };
  const deterministic = typeof random !== 'function';
  const travelMs = Math.round((topology.linkLengthM / S.speedMps) * 1000);
  const queues = {};
  const credit = {};
  for (const id of ids) {
    queues[id] = Object.fromEntries(DIRECTIONS.map((d) => [d, []]));
    credit[id] = Object.fromEntries(DIRECTIONS.map((d) => [d, 0]));
  }
  const linkById = new Map(topology.links.map((l) => [l.id, l]));
  const transit = new Map(topology.links.filter((l) => queues[l.from] && queues[l.to]).map((l) => [l.id, []]));
  const blockedNow = new Set();
  const ambulances = new Map();
  let ambulanceSerial = 0;

  const model = {
    settings: S,
    travelMs,

    isBoundary(id, dir) {
      const upstream = topology.upstreamOf(id, dir);
      return !upstream || !queues[upstream.from];
    },

    queue(id, dir) {
      return queues[id][dir];
    },

    setQueue(id, dir, arrivals) {
      queues[id][dir] = [...arrivals];
    },

    arrive(id, dir, count, t, maxQueue = Infinity) {
      const q = queues[id][dir];
      for (let i = 0; i < count && q.length < maxQueue; i += 1) q.push(t);
    },

    /** Vehicles on the link (queued at its end + in transit). */
    linkLoad(linkId) {
      const link = linkById.get(linkId);
      if (!link || !transit.has(linkId)) return null;
      return queues[link.to][link.approach].length + transit.get(linkId).length;
    },

    /** Free room on the road approach `dir` at `id` releases into (Infinity when it leaves the network). */
    space(id, dir) {
      const down = topology.downstreamOf(id, dir);
      if (!down || !transit.has(down.link.id)) return Infinity;
      return Math.max(0, down.link.capacity - queues[down.to][dir].length - transit.get(down.link.id).length);
    },

    totalQueued() {
      let n = 0;
      for (const id of ids) for (const d of DIRECTIONS) n += queues[id][d].length;
      return n;
    },

    /**
     * One simulated second. `signalsOf(id)` returns that intersection's
     * signals. Returns what happened, for metrics.
     */
    step(t, signalsOf) {
      // 1. Arrivals from upstream links.
      for (const [linkId, list] of transit) {
        if (!list.length) continue;
        const link = linkById.get(linkId);
        while (list.length && list[0] <= t) {
          list.shift();
          queues[link.to][link.approach].push(t);
        }
      }

      // 2. Discharge.
      const out = { served: 0, exited: 0, delays: [], spillback: [], spillbackOnsets: 0 };
      for (const id of ids) {
        const signals = signalsOf(id) || {};
        for (const d of DIRECTIONS) {
          const q = queues[id][d];
          const signal = signals[d];
          const key = `${id}:${d}`;
          if (signal !== 'GREEN' && signal !== 'YELLOW') {
            credit[id][d] = 0;
            blockedNow.delete(key);
            continue;
          }
          let n;
          if (deterministic) {
            credit[id][d] = Math.min(credit[id][d] + (signal === 'GREEN' ? S.satFlow : S.yellowFlow), 2);
            n = Math.floor(credit[id][d]);
          } else {
            n = signal === 'GREEN' ? 1 + (random() < S.satFlow - 1 ? 1 : 0) : (random() < S.yellowFlow ? 1 : 0);
          }
          const room = this.space(id, d);
          const can = Math.min(n, q.length, room);
          if (q.length && room <= 0 && signal === 'GREEN') {
            out.spillback.push({ intersectionId: id, approach: d });
            if (!blockedNow.has(key)) out.spillbackOnsets += 1;
            blockedNow.add(key);
          } else {
            blockedNow.delete(key);
          }
          if (deterministic) credit[id][d] -= can;
          const down = topology.downstreamOf(id, d);
          const onLink = down && transit.has(down.link.id) ? transit.get(down.link.id) : null;
          for (let k = 0; k < can; k += 1) {
            const arrived = q.shift();
            out.delays.push(t - arrived);
            out.served += 1;
            if (onLink) onLink.push(t + travelMs);
            else out.exited += 1;
          }
        }
      }
      return out;
    },

    /** What a camera at `id` would report (vehicles in view = queue + vehicles about to arrive). */
    observation(id, t, approachingBoundary = () => 0) {
      const traffic = {};
      for (const d of DIRECTIONS) {
        const q = queues[id][d];
        const upstream = topology.upstreamOf(id, d);
        let approaching = 0;
        if (upstream && transit.has(upstream.link.id)) {
          for (const ready of transit.get(upstream.link.id)) if (ready - t <= 6000) approaching += 1;
        } else {
          approaching = approachingBoundary(d);
        }
        const waiting = q.length ? q.reduce((sum, a) => sum + (t - a), 0) / q.length / 1000 : 0;
        traffic[d] = {
          vehicles: Math.min(1000, q.length + approaching),
          queueLength: Math.min(1000, q.length),
          waitingTime: Math.min(3600, Math.round(waiting * 10) / 10),
        };
      }
      return traffic;
    },

    // ------------------------------------------------------- emergency vehicles

    /**
     * Sends an emergency vehicle along `path` ([{ id, approach }], consecutive
     * intersections). It starts `startDistanceM` before the first one.
     */
    dispatch({ id, type = 'ambulance', path, startDistanceM = 150, speedMps = S.emergencySpeedMps, t }) {
      const vehicleId = id || `${type}-${(ambulanceSerial += 1)}`;
      const totalM = startDistanceM + (path.length - 1) * topology.linkLengthM;
      ambulances.set(vehicleId, {
        id: vehicleId, type, path: path.map((p) => ({ ...p })), index: 0, distanceM: startDistanceM, speedMps,
        moving: true, stops: 0, stoppedSeconds: 0, startedAt: t, freeFlowSeconds: totalM / speedMps, finishedAt: null,
      });
      return vehicleId;
    },

    /** New path from the next intersection onward (route change). */
    reroute(vehicleId, path) {
      const a = ambulances.get(vehicleId);
      if (!a || a.finishedAt !== null) return false;
      const passed = a.path.slice(0, a.index);
      a.path = [...passed, ...path.map((p) => ({ ...p }))];
      return true;
    },

    cancel(vehicleId) {
      return ambulances.delete(vehicleId);
    },

    ambulance(vehicleId) {
      return ambulances.get(vehicleId) || null;
    },

    ambulances() {
      return [...ambulances.values()];
    },

    stepAmbulances(t, signalsOf) {
      const events = [];
      for (const a of ambulances.values()) {
        if (a.finishedAt !== null) continue;
        const at = a.path[a.index];
        if (!at) {
          a.finishedAt = t;
          events.push({ type: 'finished', vehicleId: a.id });
          continue;
        }
        let move = a.speedMps;
        if (a.distanceM <= move) {
          // Reaching the stop line this second: green and room ahead, or wait.
          const signals = signalsOf(at.id) || {};
          const next = a.path[a.index + 1];
          const link = next ? linkById.get(`${at.id}>${next.id}`) : null;
          const exitFull = Boolean(link && transit.has(link.id) && this.linkLoad(link.id) >= link.capacity);
          if (signals[at.approach] === 'GREEN' && !exitFull) {
            const rest = move - a.distanceM;
            a.index += 1;
            events.push({ type: 'passed', vehicleId: a.id, intersectionId: at.id });
            if (a.index >= a.path.length) {
              a.finishedAt = t;
              events.push({ type: 'finished', vehicleId: a.id });
              continue;
            }
            a.distanceM = topology.linkLengthM - rest;
            a.moving = true;
            continue;
          }
          if (a.moving) a.stops += 1;
          a.moving = false;
          a.stoppedSeconds += 1;
          a.waitReason = exitFull ? 'road ahead full' : 'red signal';
          move = a.distanceM;
          a.distanceM = 0;
          continue;
        }
        a.distanceM -= move;
        a.moving = true;
      }
      return events;
    },

    /** Emergency vehicle the camera at `id` sees (within cameraRangeM), or null. */
    cameraSees(id) {
      for (const a of ambulances.values()) {
        if (a.finishedAt !== null) continue;
        const at = a.path[a.index];
        if (at && at.id === id && a.distanceM <= S.cameraRangeM) return { type: a.type, direction: at.approach };
      }
      return null;
    },

    /** Position reports for the corridor planner (what a GPS feed would send). */
    tracks() {
      return this.ambulances().filter((a) => a.finishedAt === null && a.path[a.index]).map((a) => ({
        id: a.id,
        type: a.type,
        source: 'simulation',
        towards: a.path[a.index].id,
        approach: a.path[a.index].approach,
        distanceM: Math.round(a.distanceM * 10) / 10,
        speedMps: a.moving ? a.speedMps : 0,
        route: a.path.map((p) => p.id),
      }));
    },
  };
  return model;
}

/** Straight path through the network from `from`, travelling `heading`. */
function straightPath(topology, from, heading) {
  const approach = OPPOSITE[heading];
  const path = [{ id: from, approach }];
  const seen = new Set([from]);
  let id = from;
  for (;;) {
    const next = topology.neighbors[id] && topology.neighbors[id][heading];
    if (!next || seen.has(next)) break;
    seen.add(next);
    path.push({ id: next, approach });
    id = next;
  }
  return path;
}

/** Path for an explicit route of adjacent intersections; the first approach is given. */
function routePath(topology, route, firstApproach) {
  const path = [{ id: route[0], approach: firstApproach }];
  for (let i = 0; i < route.length - 1; i += 1) {
    const heading = topology.headingBetween(route[i], route[i + 1]);
    if (!heading) return null;
    path.push({ id: route[i + 1], approach: OPPOSITE[heading] });
  }
  return path;
}

module.exports = { createNetworkTrafficModel, straightPath, routePath, DEFAULTS };
