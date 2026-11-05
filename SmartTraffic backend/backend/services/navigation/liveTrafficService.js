const {
  isValidLatLng, distanceMeters, locateOnLine, bearingDegrees, bboxContainsPoint,
} = require('../../utils/geo');
const { DIRECTIONS } = require('../../utils/validation');

/**
 * Live AI traffic for the mobile app, read from the LIVE decision engine
 * (the same snapshots the dashboard and the web navigation page receive).
 * Simulated data never appears here: the service is given the live engine
 * only, and any snapshot labelled dataMode "simulation" is ignored.
 *
 * Nothing is estimated where nothing was measured: an intersection without
 * an AI feed is "no-data" with null counts, an approach whose camera video
 * is unavailable is { available: false } with null counts.
 *
 * Intersection view:
 *   { id, name, lat, lng, positionSource, status: 'live' | 'stale' | 'no-data',
 *     lastUpdate, ageSeconds, level, longestQueue,
 *     approaches: { north: Approach, south, east, west } | null,
 *     emergency: { type, direction, since } | null }
 *   Approach: { available, vehicles, queueLength, waitingTime,
 *               estimatedDelaySeconds, level }
 *
 * Delay estimate for one approach (seconds), the method of the web page's
 * route ranking: mean wait of the stopped vehicles + vehicles on the
 * approach x secondsPerVehicle (one saturation headway each). `level` is
 * that estimate against NAV_MODERATE_DELAY_SECONDS / NAV_HEAVY_DELAY_SECONDS:
 * light / moderate / heavy, and only while the data is live.
 */

const round1 = (n) => Math.round(n * 10) / 10;

function levelFor(delay, cfg) {
  if (delay >= cfg.heavyDelaySeconds) return 'heavy';
  if (delay >= cfg.moderateDelaySeconds) return 'moderate';
  return 'light';
}
const LEVEL_ORDER = ['light', 'moderate', 'heavy'];

function approachView(t, live, cfg) {
  if (!t || !t.available || !Number.isFinite(t.vehicles)) {
    return {
      available: false, vehicles: null, queueLength: null, waitingTime: null, estimatedDelaySeconds: null, level: null,
    };
  }
  const waitingTime = Number.isFinite(t.waitingTime) ? t.waitingTime : (Number.isFinite(t.waiting) ? t.waiting : 0);
  const delay = round1(waitingTime + t.vehicles * cfg.secondsPerVehicle);
  return {
    available: true,
    vehicles: t.vehicles,
    queueLength: Number.isFinite(t.queueLength) ? t.queueLength : null,
    waitingTime,
    estimatedDelaySeconds: delay,
    level: live ? levelFor(delay, cfg) : null,
  };
}

/** Decision-engine snapshot -> intersection view (see module comment). */
function intersectionView(snap, cfg, nowMs) {
  const last = Date.parse(snap.lastUpdate);
  const ageSeconds = Number.isFinite(last) ? round1(Math.max(0, (nowMs - last) / 1000)) : null;
  let status = 'no-data';
  if (ageSeconds !== null) status = snap.aiStatus === 'CONNECTED' && ageSeconds <= cfg.staleAfterSeconds ? 'live' : 'stale';
  const live = status === 'live';
  const approaches = status === 'no-data' || !snap.traffic
    ? null
    : Object.fromEntries(DIRECTIONS.map((d) => [d, approachView(snap.traffic[d], live, cfg)]));

  let longestQueue = null;
  let level = null;
  if (approaches) {
    for (const d of DIRECTIONS) {
      const a = approaches[d];
      if (a.available && a.queueLength !== null && (!longestQueue || a.queueLength > longestQueue.vehicles)) {
        longestQueue = { direction: d, vehicles: a.queueLength };
      }
      if (a.level && (!level || LEVEL_ORDER.indexOf(a.level) > LEVEL_ORDER.indexOf(level))) level = a.level;
    }
  }
  const em = snap.emergency;
  return {
    id: snap.intersectionId,
    name: snap.name,
    lat: snap.lat,
    lng: snap.lng,
    positionSource: snap.positionSource || null,
    status,
    lastUpdate: Number.isFinite(last) ? new Date(last).toISOString() : null,
    ageSeconds,
    level,
    longestQueue,
    approaches,
    emergency: live && em && em.active ? { type: em.type, direction: em.direction, since: em.since || null } : null,
  };
}

// ------------------------------------------------------------- route matching

/**
 * Approach (where vehicles come from, as the AI service names it) by which
 * the line enters `point`: travelling south means entering from the north
 * approach. Null when the line starts at the point. Assumes the cameras'
 * north/south/east/west match the compass.
 */
function approachDirection(line, point, { backM = 60 } = {}) {
  if (!line || line.length < 2) return null;
  let closest = 0;
  let best = Infinity;
  line.forEach(([lng, lat], i) => {
    const d = distanceMeters({ lat, lng }, point);
    if (d < best) { best = d; closest = i; }
  });
  let i = closest;
  let walked = 0;
  const at = (k) => ({ lat: line[k][1], lng: line[k][0] });
  while (i > 0 && walked < backM) {
    walked += distanceMeters(at(i - 1), at(i));
    i -= 1;
  }
  if (walked < 10) return null;
  const heading = bearingDegrees(at(i), at(closest));
  if (heading >= 315 || heading < 45) return 'south'; // heading north: came from the south
  if (heading < 135) return 'west';
  if (heading < 225) return 'north';
  return 'east';
}

/**
 * Live delay for one route: every monitored intersection within
 * routeMatchMeters of the line, in route order.
 * Returns { delay, live, updatedAt, intersections, alerts }.
 *   intersections[]: { id, name, positionSource, status, alongMeters,
 *                      approach, delaySeconds, included, reason }
 *   reason (when not included): 'stale' | 'no-data' | 'video-unavailable'
 */
function estimateRoute(route, views, cfg) {
  const line = route.geometry.coordinates;
  const intersections = [];
  const alerts = [];
  let delay = 0;
  let live = false;
  let updatedAt = null;
  for (const ix of views) {
    if (!isValidLatLng(ix)) continue;
    // An unsurveyed position would attach the delay to the wrong road.
    if (ix.positionSource === 'placeholder' && !cfg.includePlaceholderPositions) continue;
    const { distanceMeters: d, alongMeters } = locateOnLine(ix, line);
    if (d > cfg.routeMatchMeters) continue;
    const entry = {
      id: ix.id,
      name: ix.name,
      positionSource: ix.positionSource,
      status: ix.status,
      alongMeters: Math.round(alongMeters),
      approach: null,
      delaySeconds: 0,
      included: false,
      reason: null,
    };
    if (ix.status !== 'live' || !ix.approaches) {
      entry.reason = ix.status === 'stale' ? 'stale' : 'no-data';
    } else {
      const approach = approachDirection(line, ix);
      entry.approach = approach;
      const measured = (approach ? [approach] : DIRECTIONS).map((dir) => [dir, ix.approaches[dir]]).filter(([, a]) => a.available);
      if (!measured.length) {
        entry.reason = 'video-unavailable';
      } else {
        // Unknown approach (the route starts here): the mean of the measured ones.
        entry.delaySeconds = round1(measured.reduce((s, [, a]) => s + a.estimatedDelaySeconds, 0) / measured.length);
        entry.included = true;
        delay += entry.delaySeconds;
        live = true;
        if (!updatedAt || ix.lastUpdate > updatedAt) updatedAt = ix.lastUpdate;

        const queue = approach
          ? { direction: approach, vehicles: ix.approaches[approach].queueLength }
          : ix.longestQueue;
        if (queue && queue.vehicles !== null && queue.vehicles >= cfg.longQueueVehicles) {
          alerts.push({
            type: 'long_queue',
            intersectionId: ix.id,
            direction: queue.direction,
            vehicles: queue.vehicles,
            alongMeters: entry.alongMeters,
            message: `Long queue at ${ix.name}: ${queue.vehicles} vehicles on the ${queue.direction} approach`,
          });
        }
      }
      if (ix.emergency) {
        alerts.push({
          type: 'emergency_vehicle',
          intersectionId: ix.id,
          direction: ix.emergency.direction,
          alongMeters: entry.alongMeters,
          message: `Emergency vehicle at ${ix.name}${ix.emergency.direction ? ` (${ix.emergency.direction} approach)` : ''}: expect signal priority`,
        });
      }
    }
    intersections.push(entry);
  }
  intersections.sort((a, b) => a.alongMeters - b.alongMeters);
  alerts.sort((a, b) => a.alongMeters - b.alongMeters);
  return {
    delay: round1(delay), live, updatedAt, intersections, alerts,
  };
}

/**
 * Whether live traffic is part of the route estimates:
 *   included      at least one route's estimate contains live AI data
 *   unavailable   a route passes a monitored intersection without live data
 *   not-on-route  no route passes a monitored intersection
 */
function trafficStatus(estimates) {
  if (estimates.some((e) => e.live)) return 'included';
  if (estimates.some((e) => e.intersections.length)) return 'unavailable';
  return 'not-on-route';
}

function createLiveTrafficService({ engine, config, now = Date.now }) {
  const cfg = config;
  const views = () => {
    const t = now();
    return engine.getAllSnapshots()
      .filter((snap) => snap.dataMode !== 'simulation')
      .map((snap) => intersectionView(snap, cfg, t));
  };

  return {
    views,

    /** All monitored intersections, optionally only those inside bbox. */
    list({ bbox = null } = {}) {
      const all = views();
      return {
        serverTime: new Date(now()).toISOString(),
        staleAfterSeconds: cfg.staleAfterSeconds,
        intersections: bbox ? all.filter((v) => isValidLatLng(v) && bboxContainsPoint(bbox, v)) : all,
      };
    },

    estimate(route, list = views()) {
      return estimateRoute(route, list, cfg);
    },

    count: () => engine.ids().length,
  };
}

module.exports = {
  createLiveTrafficService, intersectionView, approachDirection, estimateRoute, trafficStatus, levelFor,
};
